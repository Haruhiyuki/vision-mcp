# Vision-MCP

**English** | [中文](README.zh-CN.md)

Vision-MCP is a desktop software interaction framework for agents. It combines
an MCP server, a reusable agent skill, and native desktop helpers so agents can
operate GUI applications with lower token cost, faster execution, and less
repeated visual exploration.

The framework uses a hybrid AX/UIA + OCR + vision-model architecture. It lets
agents inspect software through the cheapest reliable signal first, then turn
successful interaction paths into reusable `vision-mcp.yaml` maps made of
actions and workflows.

## Why It Exists

Agents can use screenshots and vision models to operate desktop software, but
pure visual exploration is expensive and slow. Vision-MCP gives an agent a
structured workflow:

1. Explore a GUI task once with accessibility trees, OCR, screenshots, and
   visual fallback.
2. Record stable states, locators, actions, postconditions, and workflows in a
   `vision-mcp.yaml` map.
3. Reuse those actions and workflows on later runs.
4. Patch the map when the UI shifts instead of rediscovering the whole task.

For repeated desktop workflows, this turns software use from one-off visual
search into an increasingly reusable instruction layer.

## How It Works

### Reusable GUI Maps

On the first run, the agent explores the application state, clickable controls,
state transitions, and expected results. Vision-MCP stores that knowledge in
`vision-mcp.yaml` as:

- reusable **actions**, such as clicking a specific control or entering text
- higher-level **workflows**, composed from multiple actions
- state anchors and postconditions used to verify progress
- patch overlays that keep runtime fixes separate from trusted baseline maps

On later runs, the agent discovers available actions through MCP tools, reuses
existing workflows when possible, and only falls back to exploration when the
map does not yet cover the requested task.

### Hybrid Exploration

Vision-MCP gives the agent multiple ways to understand a GUI:

- native accessibility trees through macOS AX or Windows UIA
- OCR for text regions and verification
- screenshots and visual-model fallback for non-native or visually dense apps
- window capsules for display, geometry, foregrounding, and live view support

Native structure is preferred when it is reliable. OCR and vision are used as
fallbacks or verification layers.

## Quick Start

### Claude Code

Inside Claude Code:

```bash
/plugin marketplace add Haruhiyuki/vision-mcp
/plugin install vision-mcp@vision-mcp
```

The plugin installs the skill, MCP server configuration, examples, and helper
bootstrap path.

### Other MCP Hosts

For Codex, Cursor, Cline, OpenClaw, Hermes Agent, or any stdio MCP host, add a
server like this:

```jsonc
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@vision-mcp/cli@latest",
        "serve",
        "--apps-root",
        "${HOME}/.vision-mcp/apps"
      ]
    }
  }
}
```

Then run:

```bash
npx -y @vision-mcp/cli@latest doctor
npx -y @vision-mcp/cli@latest init-apps
```

For host-specific configuration paths, macOS and Windows permissions, upgrade
steps, and troubleshooting, see the Chinese install guide:
[INSTALL.md](INSTALL.md).

## Core Capabilities

### Platform Support

| Capability | macOS | Windows |
| --- | --- | --- |
| Native helper | Swift + ScreenCaptureKit + AX + Vision + IOKit | PowerShell 5.1 + Win32 + UIA + System.Drawing + WinRT |
| Modern screenshots | `SCScreenshotManager` on macOS 14+ | `PrintWindow PW_RENDERFULLCONTENT` on Windows 8.1+ |
| Accessibility tree | AXUIElement + osascript fallback | UIA TreeWalker + MSAA fallback |
| OCR | Vision framework | Windows.Media.Ocr |
| Input | NSPasteboard paste + CGEvent | SendInput VK_PACKET with modifier support |
| Foregrounding | `NSWorkspace.activate` | `SwitchToThisWindow`, AttachThreadInput, and fallbacks |
| Health checks | `health.snapshot` | `health.snapshot` with GDI/USER resource checks |
| Self-check | `vision-mcp doctor` | `vision-mcp doctor` |

Platform notes:

- [macOS adapter reference](skills/vision-mcp/references/platform-macos.md)
- [Windows adapter reference](skills/vision-mcp/references/platform-windows.md)

### MCP Tool Surface

| Category | Tools |
| --- | --- |
| Discovery | `list_apps`, `list_workflows`, `describe`, `describe_workflow`, `describe_action`, `list_actions` |
| Execution | `run_workflow`, `perform_action` |
| Low-level actions | `click_at`, `type_text`, `press_key`, `scroll` |
| Exploration and vision | `snapshot`, `annotated`, OCR text click helpers |
| AX/UIA | `ax-press` for macOS AXPress and Windows UIA InvokePattern |
| Continuous correction | `vision-mcp patch`, `patches` |
| Window management | `displays`, `capsule`, `restore`, `live-view` |
| Diagnostics | `doctor [--watch sec]` |
| Repair | `repair_minimal --max-level 3` |

## `vision-mcp.yaml` Map Model

Vision-MCP maps are designed to make GUI knowledge durable:

- **state**: UI pages, menus, dialogs, modals, tooltips, and system modals
- **anchors**: OCR, AX/UIA, visual hash, and window-title anchors with match policies
- **regions**: shared sidebar, toolbar, keyboard, or app-specific UI zones
- **collections**: repeated controls such as card grids, rows, or dialog buttons
- **multi-locators**: priority chains such as accessibility, OCR text, nearby text,
  image patch, normalized bounding box, and vision fallback
- **workflows**: multi-step procedures with inputs, timeouts, approval flags, and
  failure policy
- **patch overlays**: runtime or agent-authored corrections with trust levels
- **parent state links**: nested menus, dialogs, and modal chains

When authoring a map, follow the checklist in
[map-design.md](skills/vision-mcp/references/map-design.md). Full field details
are in [schema.md](skills/vision-mcp/references/schema.md).

## Agent Documentation

The agent-facing source of truth is the bundled skill:

- [skills/vision-mcp/SKILL.md](skills/vision-mcp/SKILL.md)
- [workflow guide](skills/vision-mcp/references/workflow.md)
- [map design](skills/vision-mcp/references/map-design.md)
- [examples](skills/vision-mcp/references/examples.md)
- [pitfalls](skills/vision-mcp/references/pitfalls.md)
- [patch policy](skills/vision-mcp/references/patches.md)
- [repair policy](skills/vision-mcp/references/repair-policy.md)
- [safety policy](skills/vision-mcp/references/safety.md)

Additional Chinese-language documentation:

- [Chinese README](README.zh-CN.md)
- [Installation guide](INSTALL.md)
- [Agent documentation index](AGENT-USAGE.md)
- [Deployment guide](docs/deployment.md)
- [Permissions guide](docs/permissions.md)
- [Error codes](docs/errors.md)
- [Acceptance notes](docs/acceptance.md)

## Safety

Vision-MCP maps and workflows support explicit safety controls:

- forbidden action categories such as payment, destructive actions, external
  communication, permission changes, and captcha handling
- `risk_level: requires_confirmation` or `destructive` for actions that must go
  through approval
- workflow-step `approval_required: true`
- destructive workflow steps should use `on_failure: abort`
- redaction patterns for passwords, credit cards, Steam Guard codes, bearer
  tokens, and similar secrets
- action traces with before/after screenshots, locator hits, and postcondition
  results

Desktop-control tools inherit the permissions of the MCP host and native
helper. Always respect application terms, user expectations, operating-system
security prompts, DRM, anti-cheat systems, and elevation boundaries.

## License

Apache-2.0. See [LICENSE](LICENSE) and third-party attribution in
[NOTICE](NOTICE).

Each source file includes an SPDX license header.

## Disclaimer

Maps under `examples/` describe public UI layouts of applications such as Apple
Music, Notes, Activity Monitor, example ERP screens, and Steam on Windows. They
exist to demonstrate Vision-MCP map structure and coverage patterns. They are
not endorsed or authorized by the vendors of those applications. Trademarks and
application copyrights belong to their respective owners.

Destructive workflow examples are included only to demonstrate safe map design
patterns such as `risk_level: destructive`, `approval_required: true`, and
`on_failure: abort`. They are not recommendations to perform destructive
actions.
