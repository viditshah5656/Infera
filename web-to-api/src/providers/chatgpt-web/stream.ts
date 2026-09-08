import type { StreamEvent } from '../../core/stream.js';

/**
 * Parse ChatGPT web SSE stream data.
 *
 * ChatGPT's backend-api/conversation endpoint streams lines like:
 *   data: {"message":{"id":"...","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello world"]},"status":"in_progress",...},"conversation_id":"...","error":null}
 *   data: [DONE]
 *
 * Content is accumulated in `parts[0]` — each event contains the FULL text so far,
 * so we must diff against the previous snapshot to extract the delta.
 *
 * Thinking/reasoning models (o3, o4-mini) may emit content_type "thoughts"
 * before switching to "text".
 */

export interface ChatGPTStreamState {
  lastTextContent: string;
  lastThinkingContent: string;
}

export function createStreamState(): ChatGPTStreamState {
  return { lastTextContent: '', lastThinkingContent: '' };
}

export function parseChatGPTSSELine(line: string, state: ChatGPTStreamState): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data: ')) return [];

  const data = trimmed.slice(6);
  if (data === '[DONE]') {
    return [{ type: 'done', reason: 'stop' }];
  }

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }

  // Error response
  if (parsed.error) {
    const errMsg = typeof parsed.error === 'string'
      ? parsed.error
      : parsed.error?.message || JSON.stringify(parsed.error);
    return [{ type: 'error', message: `ChatGPT: ${errMsg}` }];
  }

  const message = parsed.message;
  if (!message) return [];

  // Only process assistant messages
  if (message.author?.role !== 'assistant') return [];

  const content = message.content;
  if (!content) return [];

  const events: StreamEvent[] = [];

  const contentType = content.content_type || 'text';
  const parts: string[] = Array.isArray(content.parts)
    ? content.parts.filter((p: unknown) => typeof p === 'string')
    : [];
  const currentText = parts.join('');

  if (contentType === 'thoughts' || contentType === 'thinking') {
    // Reasoning/thinking content (o3, o4-mini)
    if (currentText.length > state.lastThinkingContent.length) {
      const delta = currentText.slice(state.lastThinkingContent.length);
      state.lastThinkingContent = currentText;
      events.push({ type: 'thinking_delta', delta });
    }
  } else {
    // Regular text content
    if (currentText.length > state.lastTextContent.length) {
      const delta = currentText.slice(state.lastTextContent.length);
      state.lastTextContent = currentText;
      events.push({ type: 'text_delta', delta });
    }
  }

  // Check for completion
  const status = message.status;
  if (status === 'finished_successfully') {
    events.push({ type: 'done', reason: 'stop' });
  } else if (status === 'finished_partial_completion') {
    events.push({ type: 'done', reason: 'length' });
  }

  return events;
}
