#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { main } from "./cli.js";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
