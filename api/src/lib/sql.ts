// A tiny interface for raw SQL inside a transaction.
// Production passes a Prisma transaction (prismaSql), tests pass a plain pg connection.
// The booking core only talks to this interface, so the same SQL runs in both.
export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs a statement and returns the number of affected rows. */
  execute(sql: string, params?: unknown[]): Promise<number>;
}

export type PrismaTx = {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
};

export function prismaSql(tx: PrismaTx): Sql {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await tx.$queryRawUnsafe(sql, ...params)) as T[];
    },
    execute(sql: string, params: unknown[] = []) {
      return tx.$executeRawUnsafe(sql, ...params);
    },
  };
}
