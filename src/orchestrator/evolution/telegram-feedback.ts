/**
 * Telegram callback handler for inline button feedback.
 *
 * Lightweight long-polling loop using raw fetch (no grammY dependency).
 * Processes TP/FP button presses and approval/rejection flows.
 */
import { logger } from '../../logger.js';
import { fetchWithTimeout } from '../minimax-client.js';
import { recordResult } from './prompt-registry.js';
import { loadEvolutionState, saveEvolutionState } from './state.js';

// --- Types ---

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; first_name: string };
    message?: { chat: { id: number }; message_id: number };
  };
}

type ApprovalCallback = (actionId: string, approved: boolean) => void;

// --- State ---

let _botToken = '';
let _approvalCallback: ApprovalCallback | null = null;

/** Initialize the feedback handler */
export function initFeedbackHandler(
  botToken: string,
  approvalCallback?: ApprovalCallback,
): void {
  _botToken = botToken;
  _approvalCallback = approvalCallback || null;
}

/** Build inline keyboard markup for finding feedback */
export function buildFindingFeedbackMarkup(findingId: string): object {
  return {
    inline_keyboard: [
      [
        { text: '\u2705 True Positive', callback_data: `tp:${findingId}` },
        { text: '\u274C False Positive', callback_data: `fp:${findingId}` },
        { text: '\uD83D\uDDD1 Dismiss', callback_data: `dismiss:${findingId}` },
      ],
    ],
  };
}

/** Build inline keyboard markup for approval flow */
export function buildApprovalMarkup(actionId: string): object {
  return {
    inline_keyboard: [
      [
        { text: '\u2705 Approve', callback_data: `approve:${actionId}` },
        { text: '\u274C Reject', callback_data: `reject:${actionId}` },
        { text: '\uD83D\uDCCB Details', callback_data: `details:${actionId}` },
      ],
    ],
  };
}

/** Send a Telegram message with inline keyboard */
export async function sendWithKeyboard(
  chatId: string,
  text: string,
  replyMarkup: object,
): Promise<number | null> {
  if (!_botToken) return null;

  try {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${_botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
          disable_notification: true,
        }),
      },
      30_000,
    );

    if (!response.ok) return null;

    const data = (await response.json()) as {
      result?: { message_id: number };
    };
    return data.result?.message_id || null;
  } catch {
    return null;
  }
}

/** Answer a callback query (dismiss the loading spinner) */
async function answerCallback(callbackId: string, text: string): Promise<void> {
  if (!_botToken) return;

  try {
    await fetchWithTimeout(
      `https://api.telegram.org/bot${_botToken}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackId,
          text,
        }),
      },
      10_000,
    );
  } catch {
    // Non-fatal
  }
}

/** Process a single callback query */
function processCallback(
  query: NonNullable<TelegramUpdate['callback_query']>,
): void {
  const data = query.data;
  if (!data) return;

  const [action, id] = data.split(':');
  if (!action || !id) return;

  switch (action) {
    case 'tp':
      recordResult(id, true);
      answerCallback(query.id, 'Recorded as True Positive').catch((err: unknown) => { logger.warn({ err }, 'Failed to answer callback query'); });
      logger.info({ findingId: id }, 'Finding marked as TP via Telegram');
      break;

    case 'fp':
      recordResult(id, false);
      answerCallback(query.id, 'Marked as False Positive').catch((err: unknown) => { logger.warn({ err }, 'Failed to answer callback query'); });
      logger.info({ findingId: id }, 'Finding marked as FP via Telegram');
      break;

    case 'dismiss':
      answerCallback(query.id, 'Dismissed').catch((err: unknown) => { logger.warn({ err }, 'Failed to answer callback query'); });
      logger.info({ findingId: id }, 'Finding dismissed via Telegram');
      break;

    case 'approve':
      if (_approvalCallback) _approvalCallback(id, true);
      answerCallback(query.id, 'Approved').catch((err: unknown) => { logger.warn({ err }, 'Failed to answer callback query'); });
      logger.info({ actionId: id }, 'Evolution action approved via Telegram');
      break;

    case 'reject':
      if (_approvalCallback) _approvalCallback(id, false);
      answerCallback(query.id, 'Rejected').catch((err: unknown) => { logger.warn({ err }, 'Failed to answer callback query'); });
      logger.info({ actionId: id }, 'Evolution action rejected via Telegram');
      break;

    case 'details':
      answerCallback(query.id, 'Details requested — check next message').catch(
        (err: unknown) => { logger.warn({ err }, 'Failed to answer callback query'); },
      );
      break;

    default:
      answerCallback(query.id, 'Unknown action').catch((err: unknown) => { logger.warn({ err }, 'Failed to answer callback query'); });
  }
}

/** Poll for Telegram updates (one batch) */
export async function pollCallbacks(): Promise<void> {
  if (!_botToken) return;

  const evoState = loadEvolutionState();
  const offset = (evoState.lastTelegramUpdateId || 0) + 1;

  try {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${_botToken}/getUpdates`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          limit: 10,
          timeout: 5,
          allowed_updates: ['callback_query'],
        }),
      },
      15_000,
    );

    if (!response.ok) return;

    const data = (await response.json()) as { result?: TelegramUpdate[] };
    const updates = data.result || [];

    for (const update of updates) {
      if (update.callback_query) {
        processCallback(update.callback_query);
      }
      evoState.lastTelegramUpdateId = update.update_id;
    }

    if (updates.length > 0) {
      saveEvolutionState(evoState);
    }
  } catch {
    // Polling failure is non-fatal
  }
}
