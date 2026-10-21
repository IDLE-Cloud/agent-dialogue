/** Pure native evidence check; a seed can auto-start before explicit drain. */
export function verifiedCodexSeed({ threadId, inputId, marker, nativeStatus, receipt, drain, messages } = {}) {
  if (typeof threadId !== 'string' || !threadId || typeof inputId !== 'string' || !/^msg_[0-9a-f]{32}$/.test(inputId) ||
      typeof marker !== 'string' || !marker || nativeStatus !== 'idle' || !Array.isArray(messages)) return false;
  if (receipt?.id !== inputId || receipt.sessionID !== threadId || receipt.type !== 'user' || receipt.delivery !== 'queue' || typeof drain?.started !== 'boolean') return false;
  const users = messages.filter(item => item?.type === 'userMessage' && item.clientId === inputId);
  if (users.length !== 1 || users[0].id !== inputId || users[0].sessionID !== threadId || typeof users[0].turnId !== 'string' || !users[0].turnId) return false;
  if (drain.started && (drain.inputId !== inputId || drain.turnId !== users[0].turnId)) return false;
  return messages.some(item => item?.type === 'agentMessage' && item.sessionID === threadId && item.turnId === users[0].turnId &&
    typeof item.text === 'string' && item.text.includes(marker));
}
