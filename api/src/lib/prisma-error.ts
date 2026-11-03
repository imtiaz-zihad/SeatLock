type ErrorLike = {
  code?: string;
  constraint?: string;
  message?: string;
  meta?: { code?: string; message?: string };
};

const asError = (err: unknown): ErrorLike | null =>
  typeof err === "object" && err !== null ? (err as ErrorLike) : null;

// Unique constraint violation.
// P2002 = Prisma ORM, 23505 = Postgres (raw queries, or via meta.code).
export function isUniqueViolation(err: unknown): boolean {
  const e = asError(err);
  if (!e) return false;
  return e.code === "P2002" || e.code === "23505" || e.meta?.code === "23505";
}

// Name of the violated constraint/index, if we can find it.
export function constraintName(err: unknown): string | null {
  const e = asError(err);
  if (!e) return null;
  if (e.constraint) return e.constraint;
  const text = `${e.meta?.message ?? ""} ${e.message ?? ""}`;
  return /(?:constraint|index) "([^"]+)"/.exec(text)?.[1] ?? null;
}

// Deadlock or serialization failure: safe to run the whole transaction again.
export function isRetryableTxError(err: unknown): boolean {
  const e = asError(err);
  if (!e) return false;
  return (
    e.code === "40P01" ||
    e.code === "40001" ||
    e.code === "P2034" ||
    e.meta?.code === "40P01" ||
    e.meta?.code === "40001" ||
    /deadlock detected/i.test(e.message ?? "")
  );
}
