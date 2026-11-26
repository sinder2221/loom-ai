export const replyLimit = 1000;

export function replyError(input) {
  if (!input.trim()) return "Enter a reply before sending.";
  return input.length > replyLimit ? "Keep your reply to 1,000 characters or fewer." : "";
}

const deliveryTones = new Map([
  ["Queued", "waiting"],
  ["Accepted by transport", "running"],
  ["Held for approval", "waiting"],
  ["Delivered to chat", "completed"],
  ["Refused", "failed"],
  ["Needs verification", "waiting"],
]);

export function deliveryStatus({ state, receipt }) {
  const hasReceipt = typeof receipt === "string" && receipt.trim();
  if (!deliveryTones.has(state) || (state === "Delivered to chat" && !hasReceipt)) {
    return { label: "Delivery unknown", tone: "waiting" };
  }
  return { label: state, tone: deliveryTones.get(state) };
}

export function chatHistory({ edge, chats, resultFor }) {
  if (!edge?.supersededChatIds.length) return [];
  const entries = chats.filter(({ id }) => id === edge.activeChatId || edge.supersededChatIds.includes(id))
    .flatMap((chat) => {
      const superseded = chat.id !== edge.activeChatId;
      const result = superseded ? resultFor(chat.id) : undefined;
      const entry = { chat, time: chat.time, label: superseded ? "Superseded" : "Replacement chat" };
      return result?.late ? [entry, { chat, time: result.time, label: "Historical result" }] : [entry];
    });
  return entries.sort((first, second) => first.time.localeCompare(second.time));
}
