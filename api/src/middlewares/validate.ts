import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { AppError, type ErrorDetail } from "../lib/errors.js";

type Schemas = {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
};

// Validates params, query and body with Zod.
// Clean, typed values are stored in res.locals.validated
// (Express 5 does not allow overwriting req.query, so we do not touch req).
export function validate(schemas: Schemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    const validated: Record<string, unknown> = {};
    const problems: ErrorDetail[] = [];

    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          problems.push({
            path: [part, ...issue.path].join("."),
            message: issue.message,
          });
        }
      }
    }

    if (problems.length > 0) {
      return next(AppError.validation(problems));
    }

    res.locals.validated = validated;
    next();
  };
}
