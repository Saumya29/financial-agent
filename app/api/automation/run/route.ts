import { NextResponse } from "next/server";

import { runAutomationCycle } from "@/lib/automation/poller";

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "AUTOMATION_CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? undefined;
  const taskLimitRaw = url.searchParams.get("taskLimit");

  let taskLimit: number | undefined;
  if (taskLimitRaw) {
    const parsed = Number.parseInt(taskLimitRaw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return NextResponse.json({ error: "taskLimit must be a positive integer" }, { status: 400 });
    }
    taskLimit = parsed;
  }

  try {
    const result = await runAutomationCycle({
      userId,
      taskBatchSize: taskLimit,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automation run failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
