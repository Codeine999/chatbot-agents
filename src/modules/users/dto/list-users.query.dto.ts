import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** ค่าว่างจาก query string ต้องกลายเป็น undefined ไม่งั้น zod มองว่าเป็นค่าที่ส่งมาจริง */
const optionalQueryString = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const emptyToUndefined = (value: unknown) =>
  value === null || value === '' ? undefined : value;

const pageNumber = (max: number, fallback: number) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(max).default(fallback),
  );

export const USER_LIST_SORTS = [
  'newest',
  'oldest',
  'lastActive',
  'name',
] as const;

export type UserListSort = (typeof USER_LIST_SORTS)[number];

const sortField = z.preprocess(
  emptyToUndefined,
  z.enum(USER_LIST_SORTS).default('newest'),
);

const paginationShape = {
  search: optionalQueryString,
  sort: sortField,
  page: pageNumber(100_000, 1),
  pageSize: pageNumber(100, 10),
};

export class ListRegisteredUsersQueryDto extends createZodDto(
  z.preprocess(
    (value) => value ?? {},
    z.object({
      ...paginationShape,
      /** ค่า statusaccount ตรง ๆ หรือ 'all' เพื่อไม่กรอง */
      status: optionalQueryString,
    }),
  ),
) {}

export class ListLineUsersQueryDto extends createZodDto(
  z.preprocess(
    (value) => value ?? {},
    z.object({
      ...paginationShape,
      /**
       * แท็บบนหน้า users ใช้ค่าเริ่มต้น 'false' คือคนที่ทักเข้ามาแต่ยังไม่ผูก
       * กับ Member — ใช้ string ไม่ใช่ boolean เพราะ z.coerce.boolean() ทำให้
       * schema ของ swagger พัง
       */
      registered: z.preprocess(
        emptyToUndefined,
        z.enum(['true', 'false', 'all']).default('false'),
      ),
    }),
  ),
) {}
