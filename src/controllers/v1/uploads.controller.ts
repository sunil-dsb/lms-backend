import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type { Request, Response } from 'express';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { Upload } from '../../shared/utils/Upload.ts';
import crypto from 'crypto';
import path from 'path';
import config from '../../config/index.ts';

// POST /api/admin/uploads/direct
export const directUpload = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    if (!req.file) {
      throw new ApiError('No file provided', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    // Determine folder from mimetype
    let folder: 'images' | 'videos' | 'documents' = 'documents';
    if (req.file.mimetype.startsWith('image/')) folder = 'images';
    else if (req.file.mimetype.startsWith('video/')) folder = 'videos';

    // Create a unique key for the file
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(req.file.originalname).toLowerCase();
    const key = `uploads/${folder}/${uniqueId}${ext}`;

    await Upload(key, req.file.buffer, req.file.mimetype);

    // Construct the public URL
    const publicUrl = `${config.r2PublicBaseUrl}/${key}`;

    res.status(200).json(
      ApiResponse.success('File uploaded successfully', {
        data: { key, publicUrl },
      }),
    );
  },
);
