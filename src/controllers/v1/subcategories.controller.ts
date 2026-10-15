import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type { Request, Response } from 'express';
import {
  subcategoryCreateSchema,
  subcategoryPatchSchema,
} from '../../shared/validations/subcategories.schema.ts';
import * as subcategoriesService from '../../services/categories/subcategories.service.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';

export const listSubcategories = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw new ApiError('Not authenticated', 401);

    const rawCategoryId = req.query.categoryId ?? req.query.category_id;
    const categoryId =
      typeof rawCategoryId === 'string' && rawCategoryId.trim().length > 0
        ? rawCategoryId.trim()
        : undefined;

    const statusParam = req.query.status as string | undefined;
    const status =
      statusParam === 'all'
        ? 'all'
        : statusParam === 'archived'
          ? 'archived'
          : 'active';

    const { page, limit, search } = getPaginationParams(req.query);

    const items = await subcategoriesService.listSubcategories(
      categoryId,
      page,
      limit,
      search,
      status,
    );
    res.status(200).json(
      ApiResponse.success('Subcategories retrieved successfully', {
        subcategories: items.items,
        meta: items.meta,
      }),
    );
  },
);

export const getSubcategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw new ApiError('Not authenticated', 401);
    const { id } = req.params;
    if (!id || typeof id !== 'string') {
      throw new ApiError('Missing subcategory id', 400);
    }

    const subcategory = await subcategoriesService.getSubcategoryById(id);
    res.status(200).json(
      ApiResponse.success('Subcategory retrieved successfully', {
        subcategory,
      }),
    );
  },
);

export const listSubcategoriesAdmin = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw new ApiError('Not authenticated', 401);
    const { categoryId } = req.params;
    if (!categoryId) throw new ApiError('Missing categoryId', 400);

    const statusParam = req.query.status as string | undefined;
    const status =
      statusParam === 'all'
        ? 'all'
        : statusParam === 'archived'
          ? 'archived'
          : 'active';

    const { page, limit, search } = getPaginationParams(req.query);

    const items = await subcategoriesService.listSubcategories(
      categoryId as string,
      page,
      limit,
      search,
      status,
    );
    res.status(200).json(
      ApiResponse.success('Subcategories retrieved successfully', {
        subcategories: items.items,
        meta: items.meta,
      }),
    );
  },
);

export const createSubcategoryAdmin = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw new ApiError('Not authenticated', 401);
    const { categoryId } = req.params;
    if (!categoryId) throw new ApiError('Missing categoryId', 400);

    const parsed = subcategoryCreateSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;

    const item = await subcategoriesService.createSubcategory(
      categoryId as string,
      parsed.data,
      { userId: req.userId },
    );
    res.status(201).json(
      ApiResponse.success('Subcategory created successfully', {
        subcategory: item,
      }),
    );
  },
);

export const updateSubcategoryAdmin = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw new ApiError('Not authenticated', 401);
    const { id } = req.params;
    if (!id) throw new ApiError('Missing subcategory id', 400);

    const parsed = subcategoryPatchSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;

    const item = await subcategoriesService.updateSubcategory(
      id as string,
      parsed.data,
    );
    res.status(200).json(
      ApiResponse.success('Subcategory updated successfully', {
        subcategory: item,
      }),
    );
  },
);

export const deleteSubcategoryAdmin = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw new ApiError('Not authenticated', 401);
    const { id } = req.params;
    if (!id) throw new ApiError('Missing subcategory id', 400);

    await subcategoriesService.deleteSubcategory(id as string);
    res
      .status(200)
      .json(
        ApiResponse.success('Subcategory deleted successfully', { ok: true }),
      );
  },
);

export const archiveSubcategoryAdmin = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw new ApiError('Not authenticated', 401);
    const { id } = req.params;
    if (!id) throw new ApiError('Missing subcategory id', 400);

    const item = await subcategoriesService.archiveSubcategory(id as string);
    res.status(200).json(
      ApiResponse.success('Subcategory archived successfully', {
        subcategory: item,
      }),
    );
  },
);

export const unarchiveSubcategoryAdmin = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw new ApiError('Not authenticated', 401);
    const { id } = req.params;
    if (!id) throw new ApiError('Missing subcategory id', 400);

    const item = await subcategoriesService.unarchiveSubcategory(id as string);
    res.status(200).json(
      ApiResponse.success('Subcategory unarchived successfully', {
        subcategory: item,
      }),
    );
  },
);
