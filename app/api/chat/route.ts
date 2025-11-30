import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

const REGION = process.env.AWS_REGION || 'us-east-1';
const AGENT_ID = process.env.BEDROCK_AGENT_ID || 'HYEOBH27GN';
const AGENT_ALIAS_ID = process.env.BEDROCK_AGENT_ALIAS_ID || 'HKYBMPQHTH';

const bedrockClient = new BedrockAgentRuntimeClient({ region: REGION });
const lastCallPerSession = new Map<string, number>();
let lastGlobalCall = 0;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function enforceCadence(sessionId: string) {
  const now = Date.now();
  const SESSION_DELAY = 2000; // 2s between requests for a single chat session
  const GLOBAL_DELAY = 800; // ~1 req/s across all sessions

  const sessionLag = (lastCallPerSession.get(sessionId) || 0) + SESSION_DELAY - now;
  const globalLag = lastGlobalCall + GLOBAL_DELAY - now;
  const waitFor = Math.max(sessionLag, globalLag, 0);

  if (waitFor > 0) {
    await sleep(waitFor);
  }

  const timestamp = Date.now();
  lastCallPerSession.set(sessionId, timestamp);
  lastGlobalCall = timestamp;
}

async function callBedrockWithRetry(command: InvokeAgentCommand, maxRetries = 2) {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const base = 500 * Math.pow(2, attempt - 1); // 500ms, 1s, 2s...
        const jitter = Math.random() * 250;
        await sleep(base + jitter);
      }
      return await bedrockClient.send(command);
    } catch (err: any) {
      const msg = err?.message || '';
      // Bedrock throttling text
      if (
        msg.includes('Your request rate is too high') ||
        err.name === 'ThrottlingException'
      ) {
        lastError = err;
        continue; // retry
      }
      // other errors: just throw
      throw err;
    }
  }
  throw lastError;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, sessionId } = body;

    if (!question || typeof question !== 'string') {
      return NextResponse.json(
        { error: 'Missing "question" in request body' },
        { status: 400 },
      );
    }

    const effectiveSessionId =
      typeof sessionId === 'string' && sessionId.trim().length > 0
        ? sessionId
        : crypto.randomUUID();

    console.log('➡️ Using sessionId:', effectiveSessionId);

    await enforceCadence(effectiveSessionId);

    const command = new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId: effectiveSessionId,
      inputText: question,
    });

    // 🔁 use retry wrapper instead of bedrockClient.send directly
    const response = await callBedrockWithRetry(command);

    let reply = '';
    const decoder = new TextDecoder();

    if (response.completion) {
      for await (const event of response.completion) {
        if (event.chunk?.bytes) {
          reply += decoder.decode(event.chunk.bytes);
        }
      }
    }

    if (!reply.trim()) {
      reply = 'Sorry, I could not get a response from the Finance Agent.';
    }

    return NextResponse.json({
      reply,
      sessionId: effectiveSessionId,
    });
  } catch (err: any) {
    console.error('❌ Error calling Bedrock Agent:', err);

    return NextResponse.json(
      {
        error:
          err?.message ||
          'Failed to contact the Finance Agent due to rate limiting or another error.',
      },
      { status: 500 },
    );
  }
}
