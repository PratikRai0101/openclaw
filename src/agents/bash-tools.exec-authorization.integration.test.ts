import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import { bindCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { buildCommandContext } from "../auto-reply/reply/commands-context.js";
import { handleInlineActions } from "../auto-reply/reply/get-reply-inline-actions.js";
import {
  createHandleInlineActionsInput,
  createTypingController,
} from "../auto-reply/reply/get-reply-inline-actions.test-support.js";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { resolveElevatedPermissions } from "../auto-reply/reply/reply-elevated.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveChatSendCallerContext } from "../gateway/server-methods/gateway-client-identity.js";
import { sharingPolicyClient } from "../gateway/session-sharing.test-utils.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { getFinishedSession, getSession, waitForExecSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool, createExecToolForReply } from "./bash-tools.exec-run.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "./bash-tools.exec-types.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

// Execution spy arguments contain inherited environment; assert only scalar projections.
const boundary = vi.hoisted(() => ({
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  prepare: vi.fn<() => Promise<void>>(),
}));
const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: boundary.spawn }),
}));
// Only the network transport is replaced; real tool/gateway identity and approval routing run.
vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: transport.call };
});
vi.mock("./shell-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell-snapshot.js")>();
  return {
    ...actual,
    maybeWrapCommandWithShellSnapshot: async (
      ...args: Parameters<typeof actual.maybeWrapCommandWithShellSnapshot>
    ) => {
      await boundary.prepare();
      return actual.maybeWrapCommandWithShellSnapshot(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const python3 = resolveExecutablePath("python3", { useCache: false });

describe.skipIf(process.platform === "win32")("gateway execution authorization boundary", () => {
  let root: string;
  let supervisor: ReturnType<typeof createProcessSupervisor> | undefined;
  beforeEach(() => {
    root = fs.realpathSync(tempDirs.make("exec-authorization-boundary-"));
    for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME", "ZDOTDIR"]) {
      vi.stubEnv(key, root);
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "1");
    setRuntimeConfigSnapshot({});
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    resetProcessRegistryForTests();
    boundary.prepare.mockReset().mockResolvedValue(undefined);
    const liveSupervisor = createProcessSupervisor();
    supervisor = liveSupervisor;
    boundary.spawn.mockReset().mockImplementation((input) => liveSupervisor.spawn(input));
    transport.call.mockReset();
  });
  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = undefined;
    resetProcessRegistryForTests();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });
  function tool(
    autoReviewer: ExecAutoReviewer,
    mode: "auto" | "ask" | "allowlist" | "full" = "auto",
    pathPrepend?: string[],
  ) {
    return createExecTool({
      agentId: "main",
      host: "gateway",
      mode,
      pathPrepend,
      safeBins: [],
      autoReviewer,
      cwd: root,
      runId: "boundary-probe-run",
      messageProvider: "webchat",
      nonInteractiveApproval: mode === "auto",
      notifyOnExit: false,
    });
  }
  function reviewer() {
    return vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "list fixture files",
    }));
  }

  function setPolicy(security: "allowlist" | "deny", allowlisted = false) {
    saveExecApprovals({
      version: 1,
      defaults: { security, ask: security === "deny" ? "off" : "on-miss", askFallback: "deny" },
      agents: allowlisted ? { main: { allowlist: [{ pattern: "/bin/ls" }] } } : {},
    });
  }

  const elevatedDefaults: ExecElevatedDefaults = {
    enabled: true,
    allowed: true,
    defaultLevel: "on",
  };

  function chatBashInput(params: {
    approvedPath: string;
    operatorAuthority?: ReturnType<typeof createAdmittedRunOperatorAuthority>;
    abortSignal?: AbortSignal;
    body?: string;
    bashForegroundMs?: number;
  }) {
    const body = params.body ?? `! /bin/ls ${params.approvedPath}`;
    const cfg = {
      commands: {
        bash: true,
        text: true,
        ...(params.bashForegroundMs === undefined
          ? {}
          : { bashForegroundMs: params.bashForegroundMs }),
      },
    };
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      CommandAuthorized: true,
      ChatType: "direct",
    });
    const command = buildCommandContext(
      { ctx, cfg, agentId: "main", isGroup: false, triggerBodyNormalized: body },
      { ownerList: [], senderIsOwner: true, isAuthorizedSender: true },
    );
    return createHandleInlineActionsInput({
      ctx,
      command,
      typing: createTypingController(),
      cleanedBody: body,
      overrides: {
        cfg,
        isGroup: false,
        sessionKey: "agent:main:main",
        allowTextCommands: true,
        elevatedEnabled: true,
        elevatedAllowed: true,
        ...(params.operatorAuthority || params.abortSignal
          ? {
              opts: {
                ...(params.operatorAuthority
                  ? { operatorAuthority: params.operatorAuthority }
                  : {}),
                ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
              },
            }
          : {}),
      },
    });
  }

  function chatBashReplyText(result: Awaited<ReturnType<typeof handleInlineActions>>) {
    if (result.kind !== "reply" || !result.reply || Array.isArray(result.reply)) {
      throw new Error("Expected a bash command reply");
    }
    return result.reply.text ?? "";
  }

  function verifiedChatSendInput(body: string) {
    const client = sharingPolicyClient({
      user: "profile-ada",
      scopes: ["operator.read", "operator.write"],
    });
    return buildTestCtx({
      ...resolveChatSendCallerContext(client),
      AgentId: "main",
      SessionKey: "agent:main:main",
      Body: body,
      BodyForAgent: body,
      BodyForCommands: body,
      RawBody: body,
      CommandBody: body,
      CommandAuthorized: true,
    });
  }

  function toolWithAuthority(
    defaults: ExecToolDefaults,
    operatorAuthority?: ReturnType<typeof createAdmittedRunOperatorAuthority>,
  ) {
    return operatorAuthority
      ? createExecToolForReply({ defaults, operatorAuthority })
      : createExecTool(defaults);
  }

  function elevatedTool(operatorAuthority?: ReturnType<typeof createAdmittedRunOperatorAuthority>) {
    return toolWithAuthority(
      {
        agentId: "main",
        host: "gateway",
        mode: "full",
        autoReviewer: reviewer(),
        cwd: root,
        runId: "elevated-authority-run",
        messageProvider: "webchat",
        nonInteractiveApproval: true,
        notifyOnExit: false,
        elevated: elevatedDefaults,
      },
      operatorAuthority,
    );
  }

  function approvalTool(operatorAuthority?: ReturnType<typeof createAdmittedRunOperatorAuthority>) {
    return toolWithAuthority(
      {
        agentId: "main",
        host: "gateway",
        mode: "ask",
        cwd: root,
        runId: "approval-boundary-run",
        messageProvider: "webchat",
        notifyOnExit: false,
        elevated: elevatedDefaults,
      },
      operatorAuthority,
    );
  }

  function gatewayMethods() {
    return transport.call.mock.calls.map(([options]) => options.method);
  }

  function approve(decision: "allow-once" | "allow-always", beforeDecision?: () => void) {
    transport.call.mockImplementation(async (options: { method?: string; params?: unknown }) => {
      if (options.method === "exec.approval.request") {
        const id = (options.params as { id?: string } | undefined)?.id;
        return { status: "accepted", id };
      }
      if (options.method === "exec.approval.waitDecision") {
        beforeDecision?.();
        return { decision };
      }
      throw new Error(`Unexpected gateway call: ${options.method}`);
    });
  }

  for (const shell of ["/bin/bash", "/bin/zsh"]) {
    it.skipIf(!fs.existsSync(shell))(
      `executes bound globs and chains without startup substitutions in ${shell}`,
      async () => {
        const command = "env -- env ls ~/approved.txt | cat && ls *.txt";
        vi.stubEnv("SHELL", shell);
        fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
        fs.writeFileSync(
          path.join(root, shell.endsWith("bash") ? ".bashrc" : ".zshrc"),
          [
            "ls() { printf 'UNREVIEWED_FUNCTION\\n'; }",
            "env() { printf 'UNREVIEWED_WRAPPER\\n'; }",
            "alias cat=false",
            "export PATH=/unreviewed-path",
            "",
          ].join("\n"),
        );
        const review = reviewer();
        const result = await tool(review).execute("bound-dispatch", { command });
        if (result.details.status !== "completed") {
          throw new Error(`Unexpected exec status: ${result.details.status}`);
        }
        expect(review.mock.calls.length).toBe(1);
        expect(review.mock.calls[0]?.[0].command).toBe(command);
        expect(transport.call).not.toHaveBeenCalled();
        expect(result.details.exitCode).toBe(0);
        expect(result.details.aggregated).toContain("approved.txt");
        expect(result.details.aggregated).not.toContain("UNREVIEWED");
        expect(boundary.spawn.mock.calls.length).toBe(1);
      },
    );
  }

  it.skipIf(!python3).each([
    { mode: "auto", command: "python probe.py *.txt", shadowed: true },
    { mode: "ask", command: "python probe.py approved.txt", shadowed: false },
  ] as const)(
    "preserves the $mode virtualenv invocation or rejects PATH drift: $command (shadowed=$shadowed)",
    async ({ mode, command, shadowed }) => {
      if (!python3) {
        throw new Error("Python is required for this virtualenv regression");
      }
      const venv = path.join(root, "venv");
      const env = { HOME: root, PATH: "/usr/bin:/bin", PYTHONNOUSERSITE: "1" };
      execFileSync(python3, ["-m", "venv", "--without-pip", "--symlinks", venv], { env });
      const interpreter = path.join(venv, "bin", "python");
      expect(fs.lstatSync(interpreter).isSymbolicLink()).toBe(true);
      const sitePackages = execFileSync(
        interpreter,
        ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
        { env, encoding: "utf8" },
      ).trim();
      if (!sitePackages.startsWith(`${venv}${path.sep}`)) {
        throw new Error("The fixture must not write outside its virtualenv");
      }
      fs.writeFileSync(
        path.join(sitePackages, "venv_fixture.py"),
        "VALUE = 'venv-package-loaded'\n",
      );
      fs.writeFileSync(
        path.join(root, "probe.py"),
        "import sys, venv_fixture; print(venv_fixture.VALUE, *sys.argv[1:])\n",
      );
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      expect(
        execFileSync(interpreter, ["probe.py", "approved.txt"], {
          cwd: root,
          env,
          encoding: "utf8",
        }).trim(),
      ).toBe("venv-package-loaded approved.txt");
      const earlierBin = path.join(root, "earlier-bin");
      fs.mkdirSync(earlierBin);
      const review = reviewer();
      if (shadowed && mode === "auto") {
        review.mockImplementation(async () => {
          fs.symlinkSync(fs.realpathSync(interpreter), path.join(earlierBin, "python"));
          return { decision: "allow-once", risk: "low", rationale: "list fixture files" };
        });
      }
      if (mode === "ask") {
        approve("allow-once", () => {
          if (shadowed) {
            fs.symlinkSync(fs.realpathSync(interpreter), path.join(earlierBin, "python"));
          }
        });
      }
      // Gateway login-shell PATH is cached; select the fixture through its explicit exec setting.
      const result = await tool(review, mode, [earlierBin, path.dirname(interpreter)]).execute(
        "venv-review",
        { command },
      );
      expect(review.mock.calls.length).toBe(mode === "auto" ? 1 : 0);
      expect(
        transport.call.mock.calls.filter(
          ([options]) => options.method === "exec.approval.waitDecision",
        ).length,
      ).toBe(mode === "ask" ? 1 : 0);
      if (shadowed) {
        expect(result.details.status).toBe("failed");
        expect(boundary.spawn.mock.calls.length).toBe(0);
        return;
      }
      if (result.details.status !== "completed") {
        throw new Error(`Unexpected exec status: ${result.details.status}`);
      }
      expect(result.details.exitCode).toBe(0);
      expect(result.details.aggregated).toBe("venv-package-loaded approved.txt");
    },
  );

  it("keeps current-policy execution pinned when an allowlisted symlink changes", async () => {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const commandPath = path.join(bin, "read-approved");
    fs.symlinkSync("/bin/cat", commandPath);
    fs.writeFileSync(path.join(root, "approved.txt"), "approved-content\n");
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
      agents: { main: { allowlist: [{ pattern: fs.realpathSync("/bin/cat") }] } },
    });
    boundary.prepare.mockImplementation(async () => {
      fs.unlinkSync(commandPath);
      fs.symlinkSync("/bin/echo", commandPath);
    });
    const review = reviewer();

    const result = await tool(review, "allowlist", [bin]).execute("allowlist-symlink", {
      command: "read-approved approved.txt",
    });

    expect(review.mock.calls.length).toBe(0);
    expect(transport.call).not.toHaveBeenCalled();
    if (result.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${result.details.status}`);
    }
    expect(result.details.exitCode).toBe(0);
    expect(result.details.aggregated).toBe("approved-content");
  });

  it("preserves startup customization for ordinary full-mode execution", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    fs.writeFileSync(path.join(root, ".bashrc"), "ls() { printf 'CUSTOMIZED\\n'; }\n");
    const review = reviewer();
    const result = await tool(review, "full").execute("full-customization", {
      command: "ls *.txt",
    });
    expect(review.mock.calls.length).toBe(0);
    if (result.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${result.details.status}`);
    }
    expect(result.details.aggregated).toBe("CUSTOMIZED");
  });

  it.each(["auto", "human-always", "current-policy"] as const)(
    "revalidates %s after asynchronous shell preparation",
    async (authority) => {
      vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      setPolicy("allowlist", authority === "current-policy");
      const review = reviewer();
      approve(authority === "human-always" ? "allow-always" : "allow-once");
      boundary.prepare.mockImplementation(async () => setPolicy("deny"));
      const mode =
        authority === "current-policy" ? "allowlist" : authority === "auto" ? "auto" : "ask";
      const pending = tool(review, mode).execute("policy-revalidation", {
        command: "/bin/ls approved.txt",
      });
      await expect(pending).rejects.toThrow("Exec approval changed before execution");
      expect(boundary.spawn.mock.calls.length).toBe(0);
      expect(review.mock.calls.length).toBe(authority === "auto" ? 1 : 0);
      expect(boundary.prepare.mock.calls.length).toBe(1);
      expect(loadExecApprovalsReadOnly().defaults?.security).toBe("deny");
    },
  );

  it("rechecks policy after deferred supervisor admission", async () => {
    let started = 0;
    const liveSupervisor = supervisor!;
    boundary.spawn.mockImplementation(async (input) => {
      await Promise.resolve();
      setPolicy("deny");
      const run = await liveSupervisor.spawn(input);
      started += 1;
      return run;
    });
    await expect(
      tool(reviewer()).execute("deferred-admission", { command: "/bin/ls" }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(started).toBe(0);
  });

  it.each([false, true])(
    "preserves human allow-always through PTY fallback (revoked=%s)",
    async (revoked) => {
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      approve("allow-always");
      const liveSupervisor = supervisor!;
      let started = 0;
      boundary.spawn.mockImplementation(async (input) => {
        if (input.mode === "pty") {
          if (revoked) {
            setPolicy("deny");
          }
          throw new Error("fixture PTY unavailable");
        }
        const run = await liveSupervisor.spawn(input);
        started += 1;
        return run;
      });
      const pending = tool(reviewer(), "ask").execute("pty-revalidation", {
        command: "/bin/ls approved.txt",
        pty: true,
      });
      if (revoked) {
        await expect(pending).rejects.toThrow("Exec approval changed before execution");
        expect(started).toBe(0);
      } else {
        const result = await pending;
        if (result.details.status !== "completed") {
          throw new Error(`Unexpected exec status: ${result.details.status}`);
        }
        expect(result.details.aggregated).toBe("approved.txt");
        expect(started).toBe(1);
        expect((loadExecApprovalsReadOnly().agents?.main?.allowlist ?? []).length).toBeGreaterThan(
          0,
        );
      }
    },
  );

  // Gateway-host execution rechecks its admitted operator authority after preparation,
  // independently of the turn's elevated-permission snapshot.
  it("refuses elevated execution when the caller's live authority ends during preparation", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
    const revoked = new AbortController();
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      signal: revoked.signal,
      assertCurrent() {},
    });
    boundary.prepare.mockImplementation(async () => {
      revoked.abort(new Error("operator authority revoked"));
    });

    const pending = elevatedTool(operatorAuthority).execute("elevated-authority-revalidation", {
      command: "/bin/ls approved.txt",
      elevated: true,
    });

    await expect(pending).rejects.toThrow("operator authority revoked");
    expect(boundary.prepare).toHaveBeenCalled();
    expect(boundary.spawn.mock.calls.length).toBe(0);
  });

  it("runs elevated execution while the caller's live authority is current", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      assertCurrent() {},
    });

    const result = await elevatedTool(operatorAuthority).execute("elevated-authority-current", {
      command: "/bin/ls approved.txt",
      elevated: true,
    });

    if (result.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${result.details.status}`);
    }
    expect(result.details.exitCode).toBe(0);
    expect(result.details.aggregated).toBe("approved.txt");
    expect(boundary.spawn.mock.calls.length).toBe(1);
  });

  it("never falls back to an ambient caller when an explicit authority is revoked", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
    const revoked = new AbortController();
    const explicitAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      signal: revoked.signal,
      assertCurrent() {},
    });
    revoked.abort(new Error("explicit authority revoked"));
    const ambientAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ambient",
      scopes: ["operator.write"],
      assertCurrent() {},
    });

    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:main", operatorAuthority: ambientAuthority },
        () =>
          elevatedTool(explicitAuthority).execute("explicit-authority", {
            command: "/bin/ls approved.txt",
            elevated: true,
          }),
      ),
    ).rejects.toThrow("explicit authority revoked");
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  // Direct commands install no partial gateway identity; approvals run through the real
  // tool/gateway routing with only the network transport replaced.
  it.each([
    { name: "an explicit caller authority", withAuthority: true },
    { name: "the ordinary main path", withAuthority: false },
  ])("registers and consumes a real approval with $name", async ({ withAuthority }) => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
    approve("allow-once");
    const operatorAuthority = withAuthority
      ? createAdmittedRunOperatorAuthority({
          profileId: "profile-ada",
          scopes: ["operator.write"],
          assertCurrent() {},
        })
      : undefined;

    const result = await approvalTool(operatorAuthority).execute("approval-boundary", {
      command: "/bin/ls approved.txt",
      elevated: true,
    });

    if (result.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${result.details.status}`);
    }
    expect(result.details.aggregated).toBe("approved.txt");
    expect(gatewayMethods()).toContain("exec.approval.request");
    expect(gatewayMethods()).toContain("exec.approval.waitDecision");
    const registered = transport.call.mock.calls.find(
      ([options]) => options.method === "exec.approval.request",
    )?.[0].params as { id?: string } | undefined;
    const waited = transport.call.mock.calls.find(
      ([options]) => options.method === "exec.approval.waitDecision",
    )?.[0].params as { id?: string } | undefined;
    expect(registered).toMatchObject({ host: "gateway", ask: "on-miss", twoPhase: true });
    expect(registered?.id).toBeTruthy();
    expect(waited).toEqual({ id: registered?.id });
    expect(boundary.spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects a partial gateway tool identity before approval registration", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
    approve("allow-once");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      signal: new AbortController().signal,
      assertCurrent() {},
    });

    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:main", operatorAuthority },
        () =>
          approvalTool().execute("partial-identity", {
            command: "/bin/ls approved.txt",
            elevated: true,
          }),
      ),
    ).rejects.toThrow("trusted operational run instance required for this gateway call");
    expect(gatewayMethods()).not.toContain("exec.approval.request");
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  // Direct chat bash builds its own exec tool; these prove the dispatcher's admitted
  // authority and cancellation reach that tool, not just a surrounding agent run.
  it.each([
    { kind: "operator authority", message: "chat bash caller revoked" },
    { kind: "reply abort signal", message: "chat bash reply operation cancelled" },
  ] as const)(
    "stops chat bash dispatch when the $kind ends during preparation",
    async ({ kind, message }) => {
      const approvedPath = path.join(root, "approved.txt");
      fs.writeFileSync(approvedPath, "fixture");
      const revoked = new AbortController();
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "profile-ada",
        scopes: ["operator.write"],
        signal: kind === "operator authority" ? revoked.signal : undefined,
        assertCurrent() {},
      });
      const abortSignal = kind === "reply abort signal" ? revoked.signal : undefined;
      boundary.prepare.mockImplementation(async () => {
        revoked.abort(new Error(message));
      });
      approve("allow-once");

      const result = await handleInlineActions(
        chatBashInput({
          approvedPath,
          operatorAuthority,
          ...(abortSignal ? { abortSignal } : {}),
        }),
      );

      const text = chatBashReplyText(result);
      expect(text).toContain("⚠️ bash failed:");
      expect(text).toContain(message);
      expect(gatewayMethods()).toContain("exec.approval.request");
      expect(gatewayMethods()).toContain("exec.approval.waitDecision");
      expect(boundary.prepare).toHaveBeenCalled();
      expect(boundary.spawn).not.toHaveBeenCalled();
    },
  );

  it("runs chat bash dispatch while the caller's live authority is current", async () => {
    const approvedPath = path.join(root, "approved.txt");
    fs.writeFileSync(approvedPath, "fixture");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      assertCurrent() {},
    });
    approve("allow-once");

    const result = await handleInlineActions(chatBashInput({ approvedPath, operatorAuthority }));

    const text = chatBashReplyText(result);
    expect(text).toContain("Exit: code 0");
    expect(text).toContain("approved.txt");
    expect(gatewayMethods()).toContain("exec.approval.request");
    expect(gatewayMethods()).toContain("exec.approval.waitDecision");
    expect(boundary.prepare).toHaveBeenCalled();
    expect(boundary.spawn).toHaveBeenCalledTimes(1);
  });

  it("composes a verified chat.send caller through elevated and inline bash into real exec", async () => {
    const approvedPath = path.join(root, "approved.txt");
    fs.writeFileSync(approvedPath, "fixture");
    const body = `! /bin/ls ${approvedPath}`;
    const ctx = verifiedChatSendInput(body);
    if (ctx.Provider !== "webchat") {
      throw new Error("Expected a WebChat caller context");
    }
    const cfg = {
      commands: {
        bash: true,
        text: true,
        ownerAllowFrom: ["profile-ada"],
        allowFrom: { webchat: ["profile-ada"] },
      },
      tools: { elevated: { enabled: true, allowFrom: { webchat: ["profile-ada"] } } },
      agents: {
        entries: {
          main: {
            tools: { elevated: { enabled: true, allowFrom: { webchat: ["profile-ada"] } } },
          },
        },
      },
    };
    const elevated = resolveElevatedPermissions({
      cfg,
      agentId: "main",
      ctx,
      provider: ctx.Provider,
    });
    expect(elevated).toEqual({ enabled: true, allowed: true, failures: [] });
    const command = buildCommandContext(
      { ctx, cfg, agentId: "main", isGroup: false, triggerBodyNormalized: body },
      resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true }),
    );
    expect(command.senderIsOwner).toBe(true);
    expect(command.isAuthorizedSender).toBe(true);
    approve("allow-once");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      assertCurrent() {},
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        command,
        typing: createTypingController(),
        cleanedBody: body,
        overrides: {
          cfg,
          isGroup: false,
          sessionKey: "agent:main:main",
          allowTextCommands: true,
          elevatedEnabled: elevated.enabled,
          elevatedAllowed: elevated.allowed,
          opts: { operatorAuthority },
        },
      }),
    );

    const text = chatBashReplyText(result);
    expect(text).toContain("Exit: code 0");
    expect(text).toContain("approved.txt");
    expect(gatewayMethods()).toContain("exec.approval.request");
    expect(gatewayMethods()).toContain("exec.approval.waitDecision");
    expect(boundary.spawn).toHaveBeenCalledTimes(1);
  });

  it("binds channel-owner authority into direct bash and blocks the effect after revocation", async () => {
    const approvedPath = path.join(root, "approved.txt");
    fs.writeFileSync(approvedPath, "fixture");
    const body = `! /bin/ls ${approvedPath}`;
    const cfg = { commands: { bash: true, text: true } };
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      CommandAuthorized: true,
      ChatType: "direct",
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      From: "telegram:42",
      To: "telegram:99",
      SenderId: "42",
    });
    const revoked = new AbortController();
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      signal: revoked.signal,
      assertCurrent() {},
    });
    bindCommandOwnerAuthority(ctx, { isCurrent: () => true, operatorAuthority });
    const opts = prepareInternalGetReplyOptions(undefined, ctx);
    expect(opts?.operatorAuthority).toBe(operatorAuthority);
    const command = buildCommandContext(
      { ctx, cfg, agentId: "main", isGroup: false, triggerBodyNormalized: body },
      { ownerList: [], senderIsOwner: true, isAuthorizedSender: true },
    );
    boundary.prepare.mockImplementation(async () => {
      revoked.abort(new Error("channel owner revoked"));
    });
    approve("allow-once");

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        command,
        typing: createTypingController(),
        cleanedBody: body,
        overrides: {
          cfg,
          isGroup: false,
          sessionKey: "agent:main:main",
          allowTextCommands: true,
          elevatedEnabled: true,
          elevatedAllowed: true,
          opts,
        },
      }),
    );

    const text = chatBashReplyText(result);
    expect(text).toContain("channel owner revoked");
    expect(gatewayMethods()).toContain("exec.approval.request");
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it("cancels a background chat bash session when its live authority ends after spawn", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    const approvedPath = path.join(root, "approved.txt");
    fs.writeFileSync(approvedPath, "fixture");
    const revoked = new AbortController();
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      signal: revoked.signal,
      assertCurrent() {},
    });

    const started = await handleInlineActions(
      chatBashInput({ approvedPath, operatorAuthority, body: "! sleep 30", bashForegroundMs: 0 }),
    );
    const sessionId = chatBashReplyText(started).match(/session ([^)]+)\)/)?.[1];
    expect(sessionId).toBeTruthy();
    const session = getSession(sessionId!);
    expect(session).toBeDefined();
    expect(boundary.spawn).toHaveBeenCalledTimes(1);

    revoked.abort(new Error("chat bash caller revoked after spawn"));
    await waitForExecSession(session!);
    expect(getFinishedSession(sessionId!)).toMatchObject({
      exited: true,
      exitReason: "manual-cancel",
    });
    // Clear the command module's active-job record before the next case.
    await handleInlineActions(chatBashInput({ approvedPath, body: "!stop" }));
  });
});
