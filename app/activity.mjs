const relationshipMessages = {
  loading: "Loading chat relationships…",
  stale: "Showing the last available chat relationships.",
  unavailable: "Chat relationships are unavailable.",
};

export function projectActivity(snapshot) {
  const { state, chats, questions, handoffs, edges } = snapshot;
  const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
  const handoffsById = new Map(handoffs.map((handoff) => [handoff.id, handoff]));
  const groups = new Map();
  const supersededIds = new Set();
  const activeIds = new Set();

  for (const edge of edges) {
    const handoff = handoffsById.get(edge.handoffId);
    const origin = chatsById.get(handoff?.originChatId);
    const active = chatsById.get(edge.activeChatId);
    if (!origin || !active) continue;

    const superseded = edge.supersededChatIds.map((id) => chatsById.get(id)).filter(Boolean);
    superseded.forEach(({ id }) => supersededIds.add(id));
    activeIds.add(active.id);
    if (!groups.has(origin.id)) groups.set(origin.id, { origin, relationships: [] });
    groups.get(origin.id).relationships.push({ handoffId: handoff.id, active, superseded });
  }

  return {
    running: chats.filter(({ id, state }) => state === "running" && (!supersededIds.has(id) || activeIds.has(id))),
    openQuestions: questions.filter(({ state, chatId }) => state === "open" && chatsById.has(chatId)),
    groups: [...groups.values()],
    message: relationshipMessages[state] ?? (groups.size ? "" : "No delegated chats yet."),
  };
}
