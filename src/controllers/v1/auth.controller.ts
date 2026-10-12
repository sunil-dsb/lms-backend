import type { Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { employees, user, account, stations, jobs } from '../../db/index.ts';
import { auth } from '../../config/auth.ts';
import {
  loginUser,
  forgotPasswordService,
  resetPasswordWithOtpService,
  getSessionService,
} from '../../services/auth/auth.service.ts';
import config from '../../config/index.ts';
import bcrypt from 'bcryptjs';
import ApiError from '../../shared/utils/ApiError.ts';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { publicEmployee } from './employees.controller.ts';

export const signUp = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { name, email, password } = req.body;

    const signUpResponse = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name,
      },
      asResponse: true,
    });

    if (!signUpResponse.ok) {
      const error = await signUpResponse.json().catch(() => ({}));
      throw new ApiError(
        error.message || 'Sign up failed',
        signUpResponse.status || 400,
        true,
        '',
        { code: error.code || 'SIGN_UP_FAILED' },
      );
    }

    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.email, email));

    // better-auth's getSetCookie() returns an array of strings
    const setCookies = signUpResponse.headers.getSetCookie();
    if (setCookies.length > 0) {
      res.setHeader('Set-Cookie', setCookies);
    }

    res
      .status(201)
      .json(ApiResponse.success('User signed up successfully', { email }));
  },
);
// ============================================================================
// GET /api/auth/me
// ============================================================================

export const me = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const session = await getSessionService(req);
    res
      .status(200)
      .json(ApiResponse.success('Session retrieved Successfully', session));
  },
);

// ============================================================================
// POST /api/auth/login
// ============================================================================

export const login = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;

    const result = await loginUser({ email, password });

    if (result.setCookies && result.setCookies.length > 0) {
      res.setHeader('Set-Cookie', result.setCookies);
    }

    // Return the token in the body — client stores it and sends it on every
    // subsequent request as:  Authorization: Bearer <token>
    res.status(200).json(
      ApiResponse.success('Login successful', {
        token: result.token,
        user: result.user,
      }),
    );
  },
);

// ============================================================================
// POST /api/auth/set-password
// Called by the employee AFTER clicking the magic link and being redirected
// to /set-password. At this point the employee is already logged in via the
// magic link session. This endpoint:
//  1. Sets their permanent password via Better Auth.
//  2. Marks the employee as active + clears the requirePasswordChange flag.
// ============================================================================

export const setPassword = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { password } = req.body as { password: string };

    // The employee must already have a session from clicking the magic link.
    const cookieSession = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    const userId: string | null = cookieSession?.user.id ?? null;

    if (!userId) {
      throw new ApiError(
        'Not authenticated. Click the invite link first.',
        401,
        true,
        '',
        {
          code: 'UNAUTHENTICATED',
        },
      );
    }

    // Find the linked employee.
    const [employee] = await db
      .select()
      .from(employees)
      .where(eq(employees.userId, userId))
      .limit(1);

    // If no employee row exists yet, the magic link just created the user but
    // hasn't linked to an employee. Link them now using their email.z
    if (!employee) {
      const [userRow] = await db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);

      if (!userRow)
        throw new ApiError('User not found', 404, true, '', {
          code: 'USER_NOT_FOUND',
        });

      const [emp] = await db
        .select()
        .from(employees)
        .where(eq(employees.email, userRow.email))
        .limit(1);

      if (!emp)
        throw new ApiError(
          'No employee record found for this account.',
          404,
          true,
          '',
          {
            code: 'EMPLOYEE_NOT_FOUND',
          },
        );

      if (emp.status === 'deactivated')
        throw new ApiError(
          'This account has been deactivated.',
          403,
          true,
          '',
          {
            code: 'EMPLOYEE_DEACTIVATED',
          },
        );

      // Hash password and upsert into Better Auth's account table.
      // This is the same bcrypt format Better Auth uses for credential accounts.
      const passwordHash = await bcrypt.hash(password, 10);
      const [existingAccount] = await db
        .select({ id: account.id })
        .from(account)
        .where(
          and(eq(account.userId, userId), eq(account.providerId, 'credential')),
        )
        .limit(1);

      if (existingAccount) {
        await db
          .update(account)
          .set({ password: passwordHash, updatedAt: new Date() })
          .where(eq(account.id, existingAccount.id));
      } else {
        await db.insert(account).values({
          id: crypto.randomUUID(),
          accountId: userId,
          providerId: 'credential',
          userId,
          password: passwordHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      await db.transaction(async (tx) => {
        await tx
          .update(employees)
          .set({ userId, status: 'active', requirePasswordChange: false })
          .where(eq(employees.id, emp.id));
        await tx
          .update(user)
          .set({ emailVerified: true })
          .where(eq(user.id, userId!));
      });

      const [updated] = await db
        .select()
        .from(employees)
        .where(eq(employees.id, emp.id))
        .limit(1);

      let stationDetails: { id: string; name: string }[] = [];
      if (updated && updated.stationIds && updated.stationIds.length > 0) {
        stationDetails = await db
          .select({ id: stations.id, name: stations.name })
          .from(stations)
          .where(inArray(stations.id, updated.stationIds));
      }

      let jobDetails: { id: string; name: string }[] = [];
      if (updated && updated.jobIds && updated.jobIds.length > 0) {
        jobDetails = await db
          .select({ id: jobs.id, name: jobs.name })
          .from(jobs)
          .where(inArray(jobs.id, updated.jobIds));
      }

      const cleanEmployee = publicEmployee(updated!);

      return void res.status(200).json(
        ApiResponse.success('Password set and account activated', {
          employee: {
            ...cleanEmployee,
            stations: stationDetails,
            jobs: jobDetails,
          },
          redirectTo: `/${updated!.languagePref}/employee/home`,
        }),
      );
    }

    // Employee already linked — just update password + clear flag.
    if (!employee.requirePasswordChange) {
      throw new ApiError('Password has already been set.', 409, true, '', {
        code: 'PASSWORD_ALREADY_SET',
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db
      .update(account)
      .set({ password: passwordHash, updatedAt: new Date() })
      .where(
        and(eq(account.userId, userId), eq(account.providerId, 'credential')),
      );

    await db
      .update(employees)
      .set({ status: 'active', requirePasswordChange: false })
      .where(eq(employees.id, employee.id));

    const [updated] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, employee.id))
      .limit(1);

    let stationDetails: { id: string; name: string }[] = [];
    if (updated && updated.stationIds && updated.stationIds.length > 0) {
      stationDetails = await db
        .select({ id: stations.id, name: stations.name })
        .from(stations)
        .where(inArray(stations.id, updated.stationIds));
    }

    let jobDetails: { id: string; name: string }[] = [];
    if (updated && updated.jobIds && updated.jobIds.length > 0) {
      jobDetails = await db
        .select({ id: jobs.id, name: jobs.name })
        .from(jobs)
        .where(inArray(jobs.id, updated.jobIds));
    }

    const cleanEmployee = publicEmployee(updated!);

    res.status(200).json(
      ApiResponse.success('Password set and account activated', {
        employee: {
          ...cleanEmployee,
          stations: stationDetails,
          jobs: jobDetails,
        },
        redirectTo: `/${updated!.languagePref}/employee/home`,
      }),
    );
  },
);

// ============================================================================
// GET /api/auth/invites/:lang/:token
// A clean redirect endpoint so we don't have to send employees the massive Better Auth verification URL.
export const verifyInvite = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { lang, token } = req.params;
    if (!token || !lang) {
      res.status(400).send('Missing language or token');
      return;
    }

    const betterAuthBaseUrl = config.betterAuthUrl || 'http://localhost:8000';
    const callbackURL = encodeURIComponent(
      `${config.frontendBaseUrl}/${lang}/employee/home`,
    );
    const newUserCallbackURL = encodeURIComponent(
      `${config.frontendBaseUrl}/${lang}/set-password`,
    );

    const invitationUrl = `${betterAuthBaseUrl}/api/auth/magic-link/verify?token=${token}&callbackURL=${callbackURL}&newUserCallbackURL=${newUserCallbackURL}`;

    // Redirect the browser to the Better Auth handler which will set the cookies and redirect to the frontend.
    res.redirect(invitationUrl);
  },
);
// ============================================================================

// ============================================================================
// POST /api/v1/auth/password/forget
// Delegates OTP generation, storage, and email delivery to Better Auth's
// emailOtp plugin via forgotPasswordService.
// ============================================================================

export const forgotPassword = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as { email: string };

    // Always respond with 200 regardless of whether the email exists
    // (Better Auth already suppresses errors for unknown addresses internally).
    try {
      await forgotPasswordService(email);
    } catch {
      // Swallow silently — prevents account enumeration.
    }

    res.status(200).json(ApiResponse.success('Verification email sent.'));
  },
);

// ============================================================================
// POST /api/v1/auth/password/reset
// Verifies the OTP via Better Auth's emailOtp plugin and updates the password.
// Input: { email, otp, password }
// ============================================================================

export const resetPasswordWithOtp = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { email, otp, password } = req.body as {
      email: string;
      otp: string;
      password: string;
    };

    await resetPasswordWithOtpService(email, otp, password);

    res.status(200).json(ApiResponse.success('Password reset successfully.'));
  },
);
