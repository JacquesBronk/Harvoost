import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { DomainError, ErrorCode } from '@harvoost/shared';

// Maps every error to the canonical envelope from API_NOTES.md:
//   { code, message, details? }
// Stack traces are NEVER returned to clients in production. Log them server-side.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let details: unknown;

    if (exception instanceof DomainError) {
      status = exception.httpStatus;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      code = ErrorCode.VALIDATION_FAILED;
      message = 'Request validation failed.';
      details = {
        fields: exception.issues.map((i) => ({ field: i.path.join('.'), error: i.message })),
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === 'object' && r !== null && 'message' in r) {
        message = String((r as { message: unknown }).message);
      } else {
        message = exception.message;
      }
      code = inferCode(status);
    } else if (exception instanceof Error) {
      this.logger.error(`unhandled.${exception.name}`, { msg: exception.message, stack: exception.stack, path: req.url });
      message = 'An internal error occurred.';
    } else {
      this.logger.error('unhandled.unknown', { exception: String(exception), path: req.url });
    }

    // Always log domain-level rejections at info, not error — they're expected paths.
    if (exception instanceof DomainError) {
      this.logger.log(`domain.${code}`, { path: req.url, status, code });
    }

    res.status(status).json({ code, message, ...(details !== undefined ? { details } : {}) });
  }
}

function inferCode(status: number): string {
  if (status === 401) return ErrorCode.OIDC_FAILURE;
  if (status === 403) return ErrorCode.RBAC_FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 409) return ErrorCode.VALIDATION_FAILED;
  if (status === 422) return ErrorCode.VALIDATION_FAILED;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status === 503) return ErrorCode.LLM_UNAVAILABLE;
  return 'HTTP_ERROR';
}
