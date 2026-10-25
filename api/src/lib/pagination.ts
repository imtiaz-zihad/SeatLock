// Cursor pagination: the client sends the last id it saw, we send the next page.
// Repositories fetch `limit + 1` rows so we can tell whether another page exists.
export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  return {
    data,
    pageInfo: {
      nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null,
      hasMore,
    },
  };
}
