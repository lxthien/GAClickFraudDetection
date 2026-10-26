import type { Env } from './env';

export async function notify(env: Env, chatId: string | null, text: string, f: typeof fetch = fetch): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch {
    // Cảnh báo là phụ; lỗi gửi không được làm hỏng vòng chấm điểm.
  }
}
