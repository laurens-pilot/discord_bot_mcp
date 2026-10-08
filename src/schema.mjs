import * as z from "zod/v4";

export const id = z.string().regex(/^[0-9]{1,20}$/);
export const timestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value),
    "Use a valid timestamp with at most three fractional second digits.",
  );
export const nonblank = (max) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Must not be blank.");
export const page = {
  after: id.optional(),
  limit: z.number().int().min(1).max(100).default(25),
};
export const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const write = {
  ...readOnly,
  readOnlyHint: false,
  idempotentHint: false,
};
export const destructive = { ...write, destructiveHint: true };

export function queryString(values) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      query.append(name, String(item));
  }
  return query.toString();
}
