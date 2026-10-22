const deliveryNames = { queued: '等待投递', delivering: '正在投递', delivered: '原生已接收', 'tool-read': '工具已读', unknown: '待核对', failed: '失败' };
const agentNames = { ready: '可接收', busy: '忙碌', unavailable: '不可用', blocked: '待核对', 'tool-pull': '主动收件' };
const element = (doc, name, text, className) => {
  const value = doc.createElement(name);
  if (text !== undefined) value.textContent = String(text);
  if (className) value.className = className;
  return value;
};
const aliasOf = (id, members) => members.find(agent => agent.id === id)?.alias ?? id;

export function renderAgent(doc, agent) {
  const card = element(doc, 'article', undefined, 'agent');
  card.append(element(doc, 'strong', agent.alias), element(doc, 'span', `上次报告：${agentNames[agent.state] ?? agent.state ?? '状态未知'}`, 'state'));
  card.append(element(doc, 'p', `${agent.harness} · ${agent.mode === 'native-push' ? '自动输入' : '工具收件'}`, 'identity'));
  const details = element(doc, 'details', undefined, 'identity');
  details.append(element(doc, 'summary', '查看绑定会话'));
  for (const [label, value] of [['Agent', agent.id], ['电脑', agent.nodeLabel], ['电脑节点', agent.nodeId], ['节点上次联系 Hub', agent.lastSeen ?? '尚无心跳'], ['服务', agent.binding?.serviceIdentity?.serviceId], ['服务地址', agent.binding?.serviceIdentity?.origin], ['版本', agent.binding?.serviceIdentity?.version], ['会话', agent.binding?.sessionId], ['项目', agent.binding?.projectId], ['目录', agent.binding?.projectDirectory]]) {
    if (value !== undefined && value !== null) details.append(element(doc, 'p', `${label}：${value}`));
  }
  card.append(details);
  return card;
}

export function renderMessage(doc, message, members = []) {
  const card = element(doc, 'article', undefined, 'message');
  card.id = `message-${message.id}`;
  card.append(element(doc, 'strong', `${aliasOf(message.sender, members)} → ${(message.to ?? []).map(id => aliasOf(id, members)).join('、')}`));
  const time = new Date(message.createdAt);
  card.append(element(doc, 'p', `${Number.isNaN(time.getTime()) ? message.createdAt : time.toLocaleString()} · ${message.id}`, 'meta'));
  if (message.replyTo) {
    const row = element(doc, 'p', undefined, 'meta'), link = element(doc, 'a', `回复 ${message.replyTo}`);
    link.setAttribute('href', `#message-${message.replyTo}`);
    row.append(link); card.append(row);
  }
  card.append(element(doc, 'p', message.text, 'body'));
  const deliveries = element(doc, 'div', undefined, 'deliveries');
  for (const delivery of message.deliveries ?? []) {
    const target = delivery.agentId ?? delivery.recipientAgentId ?? delivery.recipient;
    const badge = element(doc, 'span', `${aliasOf(target, members)}：${deliveryNames[delivery.state] ?? delivery.state}`, 'delivery');
    badge.dataset.state = delivery.state;
    deliveries.append(badge);
  }
  card.append(deliveries);
  return card;
}

export function startViewer(doc = document, request = fetch) {
  const byId = id => doc.getElementById(id);
  let rooms = [], currentRoom = null, cursor = 0, loading = false, stopped = false, timer, generation = 0, statusOffset = 0;
  const messages = new Map(), agentCards = new Map(), messageCards = new Map();
  const api = async (path, options) => {
    const response = await request(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (!response.ok) {
      const error = new Error(response.status === 401 ? '请使用有效的只读查看凭据登录。' : response.status === 403 ? '此查看凭据无权访问选定讨论组。' : '暂时无法读取 Hub，请稍后刷新。');
      error.status = response.status; throw error;
    }
    return response.status === 204 ? null : response.json();
  };
  const showError = error => { byId('error').textContent = error.message; byId('error').hidden = false; };
  const render = () => {
    const members = rooms.find(room => room.id === currentRoom)?.members ?? [];
    byId('agents').replaceChildren(...members.map(agent => {
      const signature = JSON.stringify(agent), prior = agentCards.get(agent.id);
      if (prior?.signature === signature) return prior.card;
      const card = renderAgent(doc, agent);
      if (prior) card.children[card.children.length - 1].open = prior.card.children[prior.card.children.length - 1].open;
      agentCards.set(agent.id, { signature, card }); return card;
    }));
    const names = JSON.stringify(members.map(agent => [agent.id, agent.alias]));
    byId('messages').replaceChildren(...[...messages.values()].sort((a, b) => a.seq - b.seq).map(message => {
      const signature = JSON.stringify(message) + names, prior = messageCards.get(message.id);
      if (prior?.signature === signature) return prior.card;
      const card = renderMessage(doc, message, members); messageCards.set(message.id, { signature, card }); return card;
    }));
    byId('count').textContent = `${messages.size} 条消息`;
    byId('empty').hidden = messages.size !== 0;
  };
  const history = async selectedGeneration => {
    if (!currentRoom) { render(); return; }
    let hasMore = false;
    for (let page = 0; page < 20; page++) {
      const value = await api(`/v1/history?${new URLSearchParams({ room: currentRoom, after: String(cursor), limit: '100' })}`);
      if (generation !== selectedGeneration) return;
      for (const message of value.items) messages.set(message.id, message);
      const next = value.cursor;
      hasMore = value.items.length === 100 && Number.isSafeInteger(next) && next > cursor;
      cursor = next;
      if (!hasMore) break;
    }
    byId('more').hidden = !hasMore;
    const unfinished = [...messages.values()].filter(message => (message.deliveries ?? []).some(delivery => ['queued', 'delivering', 'unknown'].includes(delivery.state)));
    const batch = Array.from({ length: Math.min(100, unfinished.length) }, (_, index) => unfinished[(statusOffset + index) % unfinished.length]);
    statusOffset = unfinished.length ? (statusOffset + batch.length) % unfinished.length : 0;
    await Promise.all(batch.map(async message => {
      const value = await api(`/v1/status?${new URLSearchParams({ id: message.id })}`);
      if (generation === selectedGeneration) messages.set(message.id, { ...value.message, deliveries: value.deliveries });
    }));
    if (generation === selectedGeneration) render();
  };
  const refresh = async () => {
    if (loading || stopped) return;
    loading = true; byId('error').hidden = true;
    const selectedGeneration = generation;
    try {
      const value = await api('/v1/context');
      rooms = value.rooms;
      if (generation !== selectedGeneration) return;
      if (!rooms.some(room => room.id === currentRoom)) { currentRoom = rooms[0]?.id ?? null; cursor = 0; messages.clear(); }
      byId('rooms').replaceChildren(...rooms.map(room => { const option = element(doc, 'option', room.label); option.value = room.id; return option; }));
      byId('rooms').value = currentRoom ?? '';
      byId('login').hidden = true; byId('workspace').hidden = false;
      await history(selectedGeneration);
      byId('connection').textContent = `已连接 · ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      byId('connection').textContent = '连接中断';
      if (error.status === 401) { byId('login').hidden = false; byId('workspace').hidden = true; }
      showError(error);
    } finally { loading = false; }
  };
  byId('login').addEventListener('submit', async event => {
    event.preventDefault();
    const token = byId('token').value;
    byId('token').value = '';
    try {
      await api('/v1/viewer-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      await refresh();
    } catch (error) { showError(error); }
  });
  byId('rooms').addEventListener('change', () => { currentRoom = byId('rooms').value; cursor = 0; messages.clear(); generation++; render(); void refresh(); });
  byId('refresh').addEventListener('click', () => { void refresh(); });
  byId('more').addEventListener('click', () => { void refresh(); });
  void refresh(); timer = setInterval(() => { void refresh(); }, 3000);
  return { refresh, close: () => { stopped = true; clearInterval(timer); } };
}

if (typeof document !== 'undefined') startViewer();
