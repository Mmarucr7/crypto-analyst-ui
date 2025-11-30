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

async function callBedrockWithRetry(command: InvokeAgentCommand, maxRetries = 2) {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = 300 * attempt; // simple backoff: 300ms, 600ms, ...
        await new Promise((res) => setTimeout(res, delay));
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