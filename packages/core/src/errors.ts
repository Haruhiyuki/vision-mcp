// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
/**
 * 设计文档 §19.2 错误码。所有 runtime/MCP 工具抛错都应使用 VisionMcpError，
 * 以便统一序列化、统一对接 MCP error 对象。
 */
export const ERROR_CODES = {
  CAPSULE_DISPLAY_MISSING: "CAPSULE_DISPLAY_MISSING",
  CAPSULE_PLATFORM_UNAVAILABLE: "CAPSULE_PLATFORM_UNAVAILABLE",
  WINDOW_NOT_FOUND: "WINDOW_NOT_FOUND",
  WINDOW_MIGRATION_FAILED: "WINDOW_MIGRATION_FAILED",
  CAPTURE_INVALID: "CAPTURE_INVALID",
  GEOMETRY_MISMATCH: "GEOMETRY_MISMATCH",
  STATE_UNKNOWN: "STATE_UNKNOWN",
  ACTION_NOT_FOUND: "ACTION_NOT_FOUND",
  ACTION_RISK_REQUIRES_CONFIRMATION: "ACTION_RISK_REQUIRES_CONFIRMATION",
  POSTCONDITION_FAILED: "POSTCONDITION_FAILED",
  PRECONDITION_FAILED: "PRECONDITION_FAILED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  REPAIR_LOW_CONFIDENCE: "REPAIR_LOW_CONFIDENCE",
  REPAIR_NOT_APPLICABLE: "REPAIR_NOT_APPLICABLE",
  INPUT_LEASE_BROKEN: "INPUT_LEASE_BROKEN",
  INPUT_LEASE_DENIED: "INPUT_LEASE_DENIED",
  LOCATOR_FAILED: "LOCATOR_FAILED",
  MAP_VALIDATION_FAILED: "MAP_VALIDATION_FAILED",
  SAFETY_POLICY_BLOCKED: "SAFETY_POLICY_BLOCKED",
  UNSUPPORTED_PLATFORM: "UNSUPPORTED_PLATFORM",
  UNKNOWN: "UNKNOWN",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class VisionMcpError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly recoverable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; recoverable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "VisionMcpError";
    this.code = code;
    this.details = options.details;
    this.recoverable = options.recoverable ?? false;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      recoverable: this.recoverable,
    };
  }
}

export function isVisionMcpError(err: unknown): err is VisionMcpError {
  return err instanceof VisionMcpError;
}
