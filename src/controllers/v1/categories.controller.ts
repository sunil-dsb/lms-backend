import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type { Request, Response } from 'express';
import {
  categoryCreateSchema,
  categoryPatchSchema,
} from '../../shared/validations/categories.schema.ts';
import { subcategoryCreateSchema } from '../../shared/validations/subcategories.schema.ts';
import * as categoriesService from '../../services/categories/categories.service.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';
import { uuidIdParam } from '../../shared/common.validation.ts';
import {
  categoryStatuses,
  type CategoryStatus,
} from '../../db/categories.schema.ts';

export const listCategories = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const { page, limit, search } = getPaginationParams(req.query);
    const rawStatus = req.query.status;
    let statusFilter: CategoryStatus | 'all' | undefined = undefined;
    if (typeof rawStatus === 'string') {
      const normalized = rawStatus.toLowerCase();
      if (
        normalized === 'all' ||
        categoryStatuses.includes(normalized as CategoryStatus)
      ) {
        statusFilter = normalized as CategoryStatus | 'all';
      }
    }

    const cats = await categoriesService.listCategories(
      page,
      limit,
      search,
      statusFilter,
    );
    res.status(200).json(
      ApiResponse.success('Categories retrieved successfully', {
        categories: cats.items,
        meta: cats.meta,
      }),
    );
  },
);

export const getCategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const param = uuidIdParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid category id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const category = await categoriesService.getCategory(param.data.id);
    res
      .status(200)
      .json(
        ApiResponse.success('Category retrieved successfully', { category }),
      );
  },
);

export const createCategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const parsed = categoryCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const cat = await categoriesService.createCategory(parsed.data, {
      userId: req.userId,
    });
    res
      .status(201)
      .json(
        ApiResponse.success('Category created successfully', { category: cat }),
      );
  },
);

export const createSubcategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const categoryId = req.params.id;
    if (typeof categoryId !== 'string' || categoryId.length === 0) {
      throw new ApiError('Missing category id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const parsed = subcategoryCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const subcat = await categoriesService.createSubcategory(
      categoryId,
      parsed.data,
      {
        userId: req.userId,
      },
    );
    res.status(201).json(
      ApiResponse.success('Subcategory created successfully', {
        subcategory: subcat,
      }),
    );
  },
);

export const updateCategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError('Missing category id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const parsed = categoryPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const cat = await categoriesService.updateCategory(id, parsed.data);
    res
      .status(200)
      .json(
        ApiResponse.success('Category updated successfully', { category: cat }),
      );
  },
);

// DELETE /api/admin/library/categories/:id
export const deleteCategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError('Missing category id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    await categoriesService.deleteCategory(id);
    res
      .status(200)
      .json(ApiResponse.success('Category deleted successfully', { ok: true }));
  },
);

export const archiveCategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const param = uuidIdParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid category id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const category = await categoriesService.archiveCategory(param.data.id);
    res
      .status(200)
      .json(
        ApiResponse.success('Category archived successfully', { category }),
      );
  },
);

export const unarchiveCategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const param = uuidIdParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid category id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const category = await categoriesService.unarchiveCategory(param.data.id);
    res
      .status(200)
      .json(
        ApiResponse.success('Category unarchived successfully', { category }),
      );
  },
);

export const updateSubcategory = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const cats = await categoriesService.listCategories();
    res.status(200).json(
      ApiResponse.success('Categories retrieved successfully', {
        categories: cats,
      }),
    );
  },
);
