import { z } from "zod";
import type { ProviderSubagentInputEvent } from "../../../../provider-subagents/store.js";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type {
  PiChildSessionFile,
  PiExtension,
  PiExtensionToolCall,
  PiExtensionToolMapping,
} from "../contract.js";

const DelegateArgs = z
  .object({
    task: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1).optional(),
    agent: z.string().trim().min(1).optional(),
    wait: z.boolean().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

const GetArgs = z
  .object({
    id: z.string().trim().min(1),
    revision: z.number().int().optional(),
    includeOutput: z.boolean().optional(),
  })
  .passthrough();

const StopArgs = z
  .object({
    id: z.string().trim().min(1),
  })
  .passthrough();

const DelegationProgress = z
  .object({
    runtimeState: z.string().optional(),
    summary: z.string().optional(),
    activeTool: z.string().optional(),
  })
  .passthrough();

const DelegationView = z
  .object({
    id: z.string().trim().min(1),
    revision: z.number().int().optional(),
    status: z.enum([
      "reserved",
      "dispatching",
      "accepted",
      "running",
      "completed",
      "blocked",
      "failed",
      "uncertain",
    ]),
    task: z.string().optional(),
    hasOutput: z.boolean().optional(),
    agent: z.string().trim().min(1).optional(),
    cwd: z.string().optional(),
    resultText: z.string().optional(),
    sessionPath: z.string().trim().min(1).optional(),
    sessionFile: z.string().trim().min(1).optional(),
    progress: DelegationProgress.optional(),
  })
  .passthrough();

const ReportItem = z
  .object({
    parentSessionId: z.string().optional(),
    childId: z.string().trim().min(1),
    agent: z.string().optional(),
    task: z.string().optional(),
    status: z.string(),
    reason: z.string().optional(),
    message: z.string().optional(),
    sessionPath: z.string().trim().min(1).optional(),
    sessionFile: z.string().trim().min(1).optional(),
  })
  .passthrough();

const ReportDetails = z
  .object({
    reports: z.array(ReportItem),
  })
  .passthrough();

function mapReceiptStatus(
  status: z.infer<typeof DelegationView>["status"] | string,
): "running" | "completed" | "failed" | "canceled" {
  switch (status) {
    case "completed":
      return "completed";
    case "blocked":
      return "canceled";
    case "failed":
    case "uncertain":
      return "failed";
    case "reserved":
    case "dispatching":
    case "accepted":
    case "running":
    default:
      return "running";
  }
}

function mapReportStatus(status: string): "running" | "completed" | "failed" | "canceled" {
  switch (status) {
    case "completed":
    case "idle":
      return "completed";
    case "blocked":
      return "canceled";
    case "failed":
    case "stopped":
      return "failed";
    case "running":
    default:
      return "running";
  }
}

export const hheeiPiSubagents: PiExtension = {
  id: "@hheei/pi-subagents",
  createSession: () => {
    const callsByAgent = new Map<string, string>();
    const readSessions = new Set<string>();

    const childSession = (id: string, file: string | undefined): PiChildSessionFile[] => {
      if (!file || readSessions.has(file)) return [];
      readSessions.add(file);
      return [{ id, file }];
    };

    const mapDelegate = (call: PiExtensionToolCall): PiExtensionToolMapping | undefined => {
      const args = DelegateArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const title = args.data.agent ?? args.data.id ?? "subagent";
      const description = args.data.task ?? "";
      const detail = {
        type: "sub_agent" as const,
        subAgentType: title,
        description,
        log: "",
      };

      if (call.status === "running") {
        return {
          detail,
          subagents: [
            {
              type: "upsert" as const,
              id: call.callId,
              title,
              description,
              toolCallId: call.callId,
              status: "running" as const,
            },
          ],
        };
      }

      if (call.status === "failed") {
        return {
          detail,
          subagents: [
            {
              type: "upsert" as const,
              id: call.callId,
              title,
              description,
              toolCallId: call.callId,
              status: "failed" as const,
            },
          ],
        };
      }

      const details = DelegationView.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      if (!details.success) {
        return { detail };
      }

      callsByAgent.set(details.data.id, call.callId);

      const targetStatus = mapReceiptStatus(details.data.status);
      const sessionPath = details.data.sessionPath ?? details.data.sessionFile;
      const childSessions = childSession(call.callId, sessionPath);

      const answer =
        details.data.resultText ??
        (!sessionPath && targetStatus !== "running"
          ? extractTextFromToolResult(call.result)?.trim()
          : undefined);

      const subagents: ProviderSubagentInputEvent[] = [
        {
          type: "upsert" as const,
          id: call.callId,
          title: details.data.agent ?? title,
          description: details.data.task ?? description,
          toolCallId: call.callId,
          status: targetStatus,
          ...(details.data.status === "blocked" ? { subtitle: "Blocked" } : {}),
        },
      ];

      if (answer && targetStatus === "completed") {
        subagents.push({
          type: "timeline" as const,
          id: call.callId,
          item: { type: "assistant_message" as const, text: answer },
        });
      }

      return {
        detail,
        subagents,
        childSessions,
      };
    };

    const mapGet = (call: PiExtensionToolCall): PiExtensionToolMapping | undefined => {
      const args = GetArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const id = callsByAgent.get(args.data.id) ?? call.callId;

      const details = DelegationView.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      if (!details.success) return undefined;

      const targetStatus = mapReceiptStatus(details.data.status);
      const sessionPath = details.data.sessionPath ?? details.data.sessionFile;
      const childSessions = childSession(id, sessionPath);

      const subagents: ProviderSubagentInputEvent[] = [
        {
          type: "upsert" as const,
          id,
          title: details.data.agent ?? args.data.id,
          description: details.data.task,
          status: targetStatus,
          ...(details.data.status === "blocked" ? { subtitle: "Blocked" } : {}),
        },
      ];

      if (details.data.resultText && targetStatus === "completed") {
        subagents.push({
          type: "timeline" as const,
          id,
          item: {
            type: "assistant_message" as const,
            text: details.data.resultText,
          },
        });
      }

      return {
        detail: {
          type: "sub_agent" as const,
          subAgentType: details.data.agent ?? args.data.id,
          description: details.data.task ?? "",
          log: "",
        },
        subagents,
        childSessions,
      };
    };

    const mapStop = (call: PiExtensionToolCall): PiExtensionToolMapping | undefined => {
      const args = StopArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const id = callsByAgent.get(args.data.id) ?? call.callId;

      return {
        detail: {
          type: "sub_agent" as const,
          subAgentType: args.data.id,
          description: `Stop ${args.data.id}`,
          log: "",
        },
        subagents: [
          {
            type: "upsert" as const,
            id,
            status: "canceled" as const,
          },
        ],
      };
    };

    return {
      mapToolCall(call) {
        if (call.toolName === "agents_delegate") return mapDelegate(call);
        if (call.toolName === "agents_get") return mapGet(call);
        if (call.toolName === "agents_stop") return mapStop(call);
        return undefined;
      },

      mapCustomMessage(message) {
        if (message.customType !== "subagent-report") return undefined;
        const parsed = ReportDetails.safeParse(message.details);
        if (!parsed.success) return undefined;

        const subagents: ProviderSubagentInputEvent[] = [];
        const childSessions: PiChildSessionFile[] = [];

        for (const report of parsed.data.reports) {
          const id = callsByAgent.get(report.childId) ?? report.childId;
          const status = mapReportStatus(report.status);
          const sessionPath = report.sessionPath ?? report.sessionFile;
          childSessions.push(...childSession(id, sessionPath));

          subagents.push({
            type: "upsert" as const,
            id,
            title: report.agent ?? report.childId,
            description: report.task,
            status,
            ...(report.status === "blocked" ? { subtitle: "Blocked" } : {}),
          });

          if (
            report.message &&
            (status === "completed" || status === "failed" || status === "canceled")
          ) {
            subagents.push({
              type: "timeline" as const,
              id,
              item: {
                type: "assistant_message" as const,
                text: report.message,
              },
            });
          }
        }

        return { subagents, childSessions };
      },
    };
  },
};
