import { describe, expect, test } from "vitest";
import { createPiExtensionHost } from "../index.js";
import { hheeiPiSubagents } from "./index.js";

const delegateArgs = {
  agent: "scout",
  task: "Search the codebase for auth",
};

describe("@hheei/pi-subagents adapter", () => {
  test("creates a running subagent card when agents_delegate starts", () => {
    const host = createPiExtensionHost(undefined, [hheeiPiSubagents]);
    const mapping = host.mapToolCall({
      callId: "spawn-1",
      toolName: "agents_delegate",
      args: delegateArgs,
      status: "running",
      result: null,
    });

    expect(mapping?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-1",
        title: "scout",
        description: delegateArgs.task,
        toolCallId: "spawn-1",
        status: "running",
      },
    ]);
  });

  test("settles a synchronous agents_delegate with completed status and result text", () => {
    const host = createPiExtensionHost(undefined, [hheeiPiSubagents]);
    const call = {
      callId: "spawn-1",
      toolName: "agents_delegate",
      args: delegateArgs,
    };

    host.mapToolCall({ ...call, status: "running", result: null });

    const end = host.mapToolCall({
      ...call,
      status: "completed",
      result: {
        content: [{ type: "text", text: "Found 3 files" }],
        details: {
          id: "agent-1",
          revision: 1,
          status: "completed",
          task: delegateArgs.task,
          agent: "scout",
          hasOutput: true,
          resultText: "Found 3 files",
          sessionPath: "/path/to/session.jsonl",
        },
      },
    });

    expect(end?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-1",
        title: "scout",
        description: delegateArgs.task,
        toolCallId: "spawn-1",
        status: "completed",
      },
      {
        type: "timeline",
        id: "spawn-1",
        item: { type: "assistant_message", text: "Found 3 files" },
      },
    ]);
    expect(end?.childSessions).toEqual([{ id: "spawn-1", file: "/path/to/session.jsonl" }]);
  });

  test("maps blocked delegation status to canceled with Blocked subtitle", () => {
    const host = createPiExtensionHost(undefined, [hheeiPiSubagents]);
    const mapping = host.mapToolCall({
      callId: "spawn-blocked",
      toolName: "agents_delegate",
      args: delegateArgs,
      status: "completed",
      result: {
        details: {
          id: "agent-2",
          revision: 1,
          status: "blocked",
          task: delegateArgs.task,
          agent: "scout",
          hasOutput: false,
        },
      },
    });

    expect(mapping?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-blocked",
        title: "scout",
        description: delegateArgs.task,
        toolCallId: "spawn-blocked",
        status: "canceled",
        subtitle: "Blocked",
      },
    ]);
  });

  test("settles an async delegation via subagent-report custom message", () => {
    const host = createPiExtensionHost(undefined, [hheeiPiSubagents]);
    // 1. Initial async delegate call
    host.mapToolCall({
      callId: "spawn-async",
      toolName: "agents_delegate",
      args: { ...delegateArgs, wait: false },
      status: "completed",
      result: {
        details: {
          id: "agent-async-1",
          revision: 1,
          status: "running",
          task: delegateArgs.task,
          agent: "scout",
          hasOutput: false,
        },
      },
    });

    // 2. Report arrives later
    const reportMapping = host.mapCustomMessage({
      role: "custom",
      customType: "subagent-report",
      content: "Task completed",
      details: {
        reports: [
          {
            parentSessionId: "parent-session-1",
            childId: "agent-async-1",
            agent: "scout",
            task: delegateArgs.task,
            status: "completed",
            reason: "normal",
            message: "Completed search successfully",
            sessionPath: "/path/to/child.jsonl",
          },
        ],
      },
    });

    expect(reportMapping?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-async",
        title: "scout",
        description: delegateArgs.task,
        status: "completed",
      },
      {
        type: "timeline",
        id: "spawn-async",
        item: { type: "assistant_message", text: "Completed search successfully" },
      },
    ]);
    expect(reportMapping?.childSessions).toEqual([
      { id: "spawn-async", file: "/path/to/child.jsonl" },
    ]);
  });

  test("updates agent card on agents_get", () => {
    const host = createPiExtensionHost(undefined, [hheeiPiSubagents]);
    host.mapToolCall({
      callId: "spawn-1",
      toolName: "agents_delegate",
      args: delegateArgs,
      status: "completed",
      result: {
        details: {
          id: "agent-1",
          revision: 1,
          status: "running",
          task: delegateArgs.task,
          agent: "scout",
          hasOutput: false,
        },
      },
    });

    const getMapping = host.mapToolCall({
      callId: "get-1",
      toolName: "agents_get",
      args: { id: "agent-1", includeOutput: true },
      status: "completed",
      result: {
        details: {
          id: "agent-1",
          revision: 2,
          status: "completed",
          task: "Updated task",
          agent: "scout",
          hasOutput: true,
          resultText: "Done with revision 2",
        },
      },
    });

    expect(getMapping?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-1",
        title: "scout",
        description: "Updated task",
        status: "completed",
      },
      {
        type: "timeline",
        id: "spawn-1",
        item: { type: "assistant_message", text: "Done with revision 2" },
      },
    ]);
  });

  test("cancels agent on agents_stop", () => {
    const host = createPiExtensionHost(undefined, [hheeiPiSubagents]);
    host.mapToolCall({
      callId: "spawn-1",
      toolName: "agents_delegate",
      args: delegateArgs,
      status: "completed",
      result: {
        details: {
          id: "agent-1",
          revision: 1,
          status: "running",
          task: delegateArgs.task,
          agent: "scout",
          hasOutput: false,
        },
      },
    });

    const stopMapping = host.mapToolCall({
      callId: "stop-1",
      toolName: "agents_stop",
      args: { id: "agent-1" },
      status: "completed",
      result: {
        details: {
          id: "agent-1",
          revision: 1,
          status: "failed",
          task: delegateArgs.task,
          agent: "scout",
          hasOutput: false,
        },
      },
    });

    expect(stopMapping?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-1",
        status: "canceled",
      },
    ]);
  });

  test("ignores unrelated tools and custom messages", () => {
    const host = createPiExtensionHost(undefined, [hheeiPiSubagents]);
    expect(
      host.mapToolCall({
        callId: "other",
        toolName: "unrelated_tool",
        args: {},
        status: "completed",
        result: null,
      }),
    ).toBeUndefined();

    expect(
      host.mapCustomMessage({
        role: "custom",
        customType: "unrelated_message",
        content: "ignore me",
      }),
    ).toBeUndefined();
  });

  test("handles 0.9.0 hex subagent IDs (e.g. agent-3f9a1c)", () => {
    const host = createPiExtensionHost(undefined, [hheeiPiSubagents]);
    const hexId = "agent-3f9a1c";

    // 1. Initial delegate
    host.mapToolCall({
      callId: "spawn-hex",
      toolName: "agents_delegate",
      args: { ...delegateArgs, wait: false },
      status: "completed",
      result: {
        details: {
          id: hexId,
          revision: 1,
          status: "running",
          task: delegateArgs.task,
          agent: "scout",
          hasOutput: false,
        },
      },
    });

    // 2. Report via subagent-report
    const reportMapping = host.mapCustomMessage({
      role: "custom",
      customType: "subagent-report",
      content: "Task done",
      details: {
        reports: [
          {
            childId: hexId,
            agent: "scout",
            task: delegateArgs.task,
            status: "completed",
            reason: "normal",
            message: "Hex ID child finished",
          },
        ],
      },
    });

    expect(reportMapping?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-hex",
        title: "scout",
        description: delegateArgs.task,
        status: "completed",
      },
      {
        type: "timeline",
        id: "spawn-hex",
        item: { type: "assistant_message", text: "Hex ID child finished" },
      },
    ]);
  });
});
