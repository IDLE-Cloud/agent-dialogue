'use strict';

// This observer only calls the viewer's same-origin, read-only API. Every piece
// of source text is inserted as text, including message bodies and diagnostics.
(() => {
  const $ = (id) => document.getElementById(id);
  const labels = {
    'ledger-stored': '账本已记录', queued: '本地排队', forwarded: '后台已转发',
    'remote-stored': '对端已收妥', 'native-admitted': '原生已受理',
    'reply-linked': '已有关联回复', pending: '待确认', unknown: '状态未知',
    rejected: '已拒绝', conflict: '记录冲突',
  };
  const evidenceLabels = {
    ledger: '通信账本', submission: '排队提交', 'worker-receipt': '后台回执',
    worker: '后台回执', outbox: '发送端记录', inbox: '接收端记录',
    'outbox-record': '发送端记录', 'inbox-record': '接收端记录',
    'forwarded-receipt': '后台转发回执', 'native-pending': '原生受理待确认',
    'forward-pending': '后台转发待确认',
    'wire-signature': '消息签名', 'wire-copy': '跨节点副本', reply: '明确回复引用',
    'queue-forwarded': '提交已关联正式消息', 'queued-submission': '本地排队提交',
  };
  const state = {
    snapshot: null, roomId: new URLSearchParams(location.hash.slice(1)).get('room') || '',
    messages: [], selected: null, reference: null, nextCursor: null, hasMore: false,
    pages: 1, scope: null, generation: 0, controller: null, refreshing: false,
    refreshAgain: false, resync: false, liveTimer: null, searchTimer: null, toastTimer: null,
    statusCodes: new Set(Object.keys(labels)), cards: new Map(),
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function str(value, fallback = '') {
    return value === undefined || value === null || value === '' ? fallback : String(value);
  }

  function short(value, length = 15) {
    const text = str(value);
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function date(value) {
    if (value === undefined || value === null || value === '') return null;
    let input = value;
    if (typeof value === 'number') input = value < 1e12 ? value * 1000 : value;
    const result = new Date(input);
    return Number.isNaN(result.getTime()) ? null : result;
  }

  function time(value, full = false) {
    const d = date(value);
    if (!d) return '时间未记录';
    return d.toLocaleString('zh-CN', full
      ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
      : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function sourceName(id) {
    return state.snapshot?.sources?.find((source) => source.id === id)?.label || str(id, '未知来源');
  }

  function room() {
    return state.snapshot?.rooms?.find((candidate) => candidate.id === state.roomId);
  }

  function issueText(issue) {
    if (typeof issue === 'string') return issue;
    return str(issue?.detail || issue?.message || issue?.reason || issue?.code, '记录存在未解析信息');
  }

  function statusCode(status) {
    return typeof status === 'string' ? status : str(status?.code || status?.status);
  }

  function statusTone(code) {
    if (['remote-stored', 'native-admitted', 'reply-linked'].includes(code)) return 'positive';
    if (['queued', 'pending', 'unknown'].includes(code)) return 'waiting';
    if (['rejected', 'conflict'].includes(code)) return 'problem';
    if (code === 'forwarded') return 'info';
    return '';
  }

  function chip(status) {
    const code = statusCode(status);
    const node = el('span', `status-chip ${statusTone(code)}`, labels[code] || status?.label || code);
    node.title = str(status?.detail, labels[code] || code);
    return node;
  }

  function badge(text, className = '') {
    const node = el('span', `meta-chip ${className}`, text);
    node.title = str(text);
    return node;
  }

  function messageHasIssue(message) {
    return (message.issues?.length || 0) > 0 || (message.statuses || []).some((status) => statusCode(status) === 'conflict');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (!response.ok) {
      let body;
      try { body = await response.json(); } catch { /* The status is sufficient. */ }
      const error = new Error(str(body?.error, `读取失败（HTTP ${response.status}）`));
      error.status = response.status;
      if (response.status === 401 || response.status === 403) error.message = '本地访问会话已失效。请使用 CLI 输出的完整查看器地址重新打开。';
      throw error;
    }
    return response.json();
  }

  function setError(message) {
    $('error-banner').textContent = str(message);
    $('error-banner').hidden = !message;
  }

  function notify(message) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800);
  }

  function notice(message) {
    $('notice').textContent = message;
    $('notice').hidden = !message;
  }

  function filters() {
    return {
      source: $('filter-source').value,
      participant: $('filter-participant').value,
      status: $('filter-status').value,
      q: $('search').value.trim(),
    };
  }

  function params(extra = {}) {
    const query = new URLSearchParams({ room: state.roomId });
    for (const [key, value] of Object.entries({ ...filters(), ...extra })) {
      if (value !== '' && value !== null && value !== undefined) query.set(key, String(value));
    }
    return query.toString();
  }

  function setOptions(select, values, fallback) {
    const current = select.value;
    select.replaceChildren(new Option(fallback, ''));
    for (const [value, label] of values) select.add(new Option(label, value));
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  function renderSources() {
    const list = $('source-list');
    list.replaceChildren();
    for (const source of state.snapshot?.sources || []) {
      const row = el('div', 'source-item');
      const unavailable = source.available === false || source.stale || source.error;
      row.append(el('span', `source-dot${unavailable ? ' error' : ''}`));
      const content = el('div');
      content.append(el('span', 'source-name', str(source.label, source.id)));
      const observed = source.observedAt ? `最后采集 ${time(source.observedAt)}` : '尚无可读快照';
      const observedNode = el('span', 'source-time', `${unavailable ? '读取受限 · ' : ''}${observed}`);
      observedNode.title = source.observedAt ? time(source.observedAt, true) : observed;
      content.append(observedNode);
      if (source.error) content.append(el('span', 'source-error', typeof source.error === 'string' ? source.error : issueText(source.error)));
      if (source.diagnostics?.length) {
        content.append(el('span', 'source-error', `部分证据读取受限（${source.diagnostics.length} 项）`));
        for (const diagnostic of source.diagnostics.slice(0, 3)) content.append(el('span', 'source-error', issueText(diagnostic)));
      }
      row.append(content);
      list.append(row);
    }
    if (!list.childNodes.length) list.append(el('p', 'sidebar-empty quiet', '未登记数据源'));
  }

  function renderRooms() {
    const rooms = state.snapshot?.rooms || [];
    $('room-count').textContent = String(rooms.length);
    const list = $('room-list');
    list.replaceChildren();
    for (const candidate of rooms) {
      const button = el('button', `room-button${candidate.id === state.roomId ? ' selected' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-current', candidate.id === state.roomId ? 'true' : 'false');
      button.title = `${candidate.name}\n${candidate.roomId || candidate.id}`;
      const title = el('div', 'room-button-title');
      title.append(el('span', 'room-symbol', '#'), el('span', 'room-button-name', candidate.name || '未命名 room'));
      if (candidate.issues?.length) title.append(el('span', 'room-issue'));
      const desc = el('div', 'room-button-desc');
      desc.append(el('span', 'room-button-id', short(candidate.roomId || candidate.id, 17)), el('span', '', `${candidate.messageCount || 0} 条`));
      button.append(title, desc);
      button.addEventListener('click', () => selectRoom(candidate.id));
      list.append(button);
    }
    if (!rooms.length) list.append(el('p', 'quiet sidebar-empty', '当前来源尚无可展示的 room。来源读取异常会显示在下方。'));
  }

  function renderHeading() {
    const current = room();
    $('room-title').textContent = current?.name || '查看 Agent 之间的协作';
    $('breadcrumb-room').textContent = current?.name || '对话查看器';
    const count = current?.participants?.length || 0;
    $('room-description').textContent = current
      ? `${count} 位参与者 · ${current.sourceIds?.length || 0} 个本地来源 · 查看实际交换的消息与投递证据`
      : '选择一个项目对话，查看实际消息、参与身份和投递证据。';
    const meta = $('room-meta');
    meta.replaceChildren();
    if (current) {
      const roomIdentity = badge(short(current.roomId || current.id, 28), 'mono');
      roomIdentity.title = str(current.roomId || current.id);
      meta.append(roomIdentity);
      if (current.revision !== undefined && current.revision !== null) meta.append(badge(`revision ${current.revision}`));
      if (!current.manifestHash) meta.append(badge('来源独立的对话范围'));
      for (const id of current.sourceIds || []) meta.append(badge(sourceName(id)));
      if (current.issues?.length) meta.append(badge(`${current.issues.length} 项记录提示`, 'issue'));
    }
    $('export-json').disabled = !current;
    $('export-markdown').disabled = !current;
    $('search').disabled = !current;
    for (const id of ['filter-source', 'filter-participant', 'filter-status']) $(id).disabled = !current;
    const sources = (current?.sourceIds || []).map((id) => [id, sourceName(id)]);
    setOptions($('filter-source'), sources, '全部来源');
    const participants = current?.participants || [];
    const participantOptions = new Map();
    for (const person of participants) {
      const alias = personName(person);
      const repeated = participants.filter((item) => item.alias === person.alias).length > 1;
      const label = repeated ? `${alias} · ${short(person.nodeId || person.bindingId, 12)}` : alias;
      participantOptions.set(str(person.bindingId, alias), label);
    }
    setOptions($('filter-participant'), [...participantOptions], '全部成员');
    renderStatusOptions();
  }

  function renderStatusOptions() {
    setOptions($('filter-status'), [...state.statusCodes].map((code) => [code, labels[code] || code]), '全部状态');
  }

  function personName(person) { return str(person?.alias, '未知成员'); }

  function avatar(person) {
    const name = personName(person);
    let hash = 0;
    for (const char of str(person?.bindingId, name)) hash = (hash + char.charCodeAt(0)) % 4;
    return el('span', `avatar tone-${hash}`, name.replace(/^[@\s]+/, '').slice(0, 2).toUpperCase());
  }

  function renderMessage(message, preview = false) {
    const classes = ['message-card'];
    if (state.selected?.id === message.id) classes.push('selected');
    if (message.kind === 'submission' || message.kind === 'queued' || message.kind === 'queued-submission') classes.push('queue');
    if (messageHasIssue(message)) classes.push('conflict');
    const card = el('article', classes.join(' '));
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${personName(message.from)} 发送给 ${personName(message.to)}，${time(message.timestamp)}`);
    const header = el('div', 'message-header');
    const who = el('div', 'message-who');
    const names = el('div', 'message-names');
    const recipientLabel = message.recipients?.length > 1 ? `${message.recipients.length} 位接收者` : personName(message.to);
    names.append(el('span', 'sender-name', personName(message.from)), el('span', 'message-arrow', '→'), el('span', 'recipient-name', recipientLabel));
    if (message.from?.harness) names.append(el('span', 'harness-tag', message.from.harness));
    if (message.transport === 'hcom' && message.from?.harness !== 'hcom') names.append(el('span', 'harness-tag', 'hcom 原始消息'));
    who.append(names);
    const identity = el('div', 'message-identity');
    const node = el('span', '', message.from?.nodeId ? `node ${short(message.from.nodeId, 12)}` : 'node 未记录');
    node.title = str(message.from?.nodeId, '此记录未保留节点身份');
    const binding = el('span', '', message.from?.bindingId ? `binding ${short(message.from.bindingId, 10)} · r${message.from.revision ?? '?'}` : 'binding 未记录');
    binding.title = str(message.from?.bindingId, '此记录未保留绑定身份');
    identity.append(node, binding);
    who.append(identity);
    const stamp = el('time', 'message-time', time(message.timestamp));
    stamp.title = time(message.timestamp, true);
    if (date(message.timestamp)) stamp.dateTime = date(message.timestamp).toISOString();
    header.append(avatar(message.from), who, stamp);
    card.append(header);
    if (message.replyTo) {
      const reply = message.replyTo;
      const button = el('button', `reply-reference${reply.missing ? ' missing' : ''}`);
      button.type = 'button';
      button.append(el('span', '', '↳'), el('span', '', reply.id
        ? `回复 ${short(reply.reference || reply.id, 32)} · 点击定位原消息`
        : `引用未采集：${short(reply.reference, 32)}`));
      button.title = reply.reason || (reply.missing ? '原消息不在当前采集范围内；不能据此判断它未发生。' : str(reply.reference));
      button.addEventListener('click', (event) => { event.stopPropagation(); jumpToReply(reply); });
      card.append(button);
    }
    card.append(el('p', 'message-body', str(message.text, '（空正文）')));
    const footer = el('div', 'message-footer');
    const statuses = el('div', 'message-statuses');
    for (const status of message.statuses || []) statuses.append(chip(status));
    if (!statuses.childNodes.length) statuses.append(el('span', 'status-chip', '证据未记录'));
    const sourceNames = (message.sourceIds || []).map(sourceName);
    const source = el('span', 'message-source', sourceNames.join(' · ') || '来源未记录');
    source.title = sourceNames.join('\n');
    footer.append(statuses, source);
    card.append(footer);
    if (message.issues?.length) card.append(el('div', 'message-issues', message.issues.map(issueText).join(' · ')));
    const select = () => selectMessage(message);
    card.addEventListener('click', select);
    card.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === card) { event.preventDefault(); select(); }
    });
    if (!preview) state.cards.set(message.id, card);
    return card;
  }

  function renderTimeline({ scrollToBottom = false, preserveScroll = true } = {}) {
    const scroll = $('timeline-scroll');
    const oldTop = scroll.scrollTop;
    const oldHeight = scroll.scrollHeight;
    const nearBottom = oldHeight - oldTop - scroll.clientHeight < 70;
    const timeline = $('timeline');
    timeline.replaceChildren();
    state.cards.clear();
    for (const message of state.messages) timeline.append(renderMessage(message));
    if (!state.messages.length) {
      const empty = el('div', 'empty-state');
      empty.append(el('span', 'empty-icon', '↔'), el('h2', '', room() ? '当前范围没有消息' : '选择一个项目对话'));
      const filtered = Object.values(filters()).some(Boolean);
      empty.append(el('p', '', filtered ? '可以调整筛选条件，或清空搜索重新查看。' : '尚无可展示的通信账本记录。来源异常和缺失会单独列明。'));
      timeline.append(empty);
    }
    const total = state.scope?.total ?? state.messages.length;
    $('timeline-count').textContent = `消息时间线 · ${total} 条`;
    $('history-control').hidden = !state.hasMore;
    $('scope-note').textContent = room() ? `已载入 ${state.messages.length} / ${total} 条 · 导出覆盖当前筛选范围${filters().source ? '，保留所有来源证据' : ''}` : '未选择对话';
    $('clear-filters').hidden = !Object.values(filters()).some(Boolean);
    renderReference();
    requestAnimationFrame(() => {
      if (scrollToBottom || (preserveScroll && nearBottom)) scroll.scrollTop = scroll.scrollHeight;
      else if (preserveScroll) scroll.scrollTop = oldTop + (scroll.scrollHeight - oldHeight);
    });
  }

  function renderReference() {
    const preview = $('reply-preview');
    preview.replaceChildren();
    if (!state.reference || state.cards.has(state.reference.id)) { preview.hidden = true; return; }
    preview.hidden = false;
    const wrapper = el('div', 'reference-preview');
    const header = el('div', 'reference-label');
    const close = el('button', 'text-button', '收起');
    close.type = 'button';
    close.addEventListener('click', () => { state.reference = null; renderReference(); });
    header.append(el('span', '', '引用原消息 · 位于当前列表范围之外'), close);
    wrapper.append(header, renderMessage(state.reference, true));
    preview.append(wrapper);
  }

  function detailField(grid, key, value, plain = false) {
    grid.append(el('dt', '', key), el('dd', plain ? 'plain' : '', str(value, '未记录')));
  }

  function personDetail(person, role) {
    const node = el('div', 'participant');
    const header = el('div', 'participant-header');
    const heading = el('div');
    heading.append(el('div', 'participant-title', `${personName(person)}${role ? ` · ${role}` : ''}`), el('div', 'participant-harness', str(person?.harness, 'harness 未记录')));
    header.append(avatar(person), heading);
    const grid = el('dl', 'identity-grid');
    detailField(grid, 'Node', person?.nodeId);
    detailField(grid, 'Binding', person?.bindingId);
    detailField(grid, 'Revision', person?.revision);
    detailField(grid, 'Session', person?.sessionId);
    if (person?.active === false) detailField(grid, '当前状态', '历史绑定（当前已分离）', true);
    else if (person?.active === true) detailField(grid, '当前状态', '绑定有效；不代表进程在线', true);
    node.append(header, grid);
    return node;
  }

  function detailSection(title) {
    const section = el('section', 'detail-section');
    section.append(el('h2', 'detail-section-title', title));
    return section;
  }

  function renderDetails() {
    const details = $('details');
    details.replaceChildren();
    const current = room();
    const selected = state.selected;
    if (!current && !selected) {
      const intro = el('div', 'detail-intro');
      intro.append(el('span', 'detail-intro-symbol', '◎'), el('h2', '', '身份清楚，证据可追溯'), el('p', '', '选择一条消息，查看它来自哪个节点和原生会话，以及实际记录到的投递证据。'));
      details.append(intro);
      return;
    }
    if (selected) {
      const section = detailSection('选中消息 / MESSAGE');
      section.append(el('p', 'detail-meta', `${time(selected.timestamp, true)}\n${selected.id}`));
      if (selected.transport === 'hcom') section.append(el('p', 'detail-meta', '原始 hcom 消息 · 按来源区分身份与对话范围'));
      const statuses = el('div', 'message-statuses');
      for (const status of selected.statuses || []) statuses.append(chip(status));
      section.append(statuses);
      const actions = el('div', 'identity-actions');
      const copy = el('button', 'text-button', '复制消息与身份');
      copy.type = 'button';
      copy.addEventListener('click', () => copyText(JSON.stringify({ id: selected.id, text: selected.text, from: selected.from, to: selected.to, recipients: selected.recipients, transport: selected.transport, sourceIds: selected.sourceIds, replyTo: selected.replyTo }, null, 2)));
      actions.append(copy);
      section.append(actions);
      for (const issue of selected.issues || []) section.append(el('p', 'detail-issue', issueText(issue)));
      details.append(section);
      const identity = detailSection('准确身份 / IDENTITY');
      identity.append(personDetail(selected.from, '发送'));
      const recipients = selected.recipients?.length ? selected.recipients : [selected.to];
      for (const recipient of recipients) identity.append(personDetail(recipient, '接收'));
      details.append(identity);
      const evidenceSection = detailSection(`投递证据 / ${selected.evidence?.length || 0} 项`);
      const list = el('div', 'evidence-list');
      for (const evidence of selected.evidence || []) {
        const item = el('div', 'evidence-item');
        const line = el('div', 'evidence-topline');
        line.append(el('span', 'evidence-title', evidenceLabels[evidence.type] || str(evidence.type, '记录证据')), el('span', 'evidence-source', sourceName(evidence.sourceId)));
        item.append(line);
        const summary = [];
        if (evidence.status) summary.push(labels[evidence.status] || evidence.status);
        if (evidence.localEventId !== undefined && evidence.localEventId !== null) summary.push(`本地事件 #${evidence.localEventId}`);
        if (evidence.remoteEventId !== undefined && evidence.remoteEventId !== null) summary.push(`对端事件 #${evidence.remoteEventId}`);
        if (evidence.at) summary.push(time(evidence.at, true));
        if (summary.length) item.append(el('p', 'evidence-detail', summary.join(' · ')));
        if (evidence.detail) item.append(el('p', 'evidence-detail', typeof evidence.detail === 'string' ? evidence.detail : JSON.stringify(evidence.detail)));
        const raw = el('details', 'raw-details');
        raw.append(el('summary', '', '展开记录字段'), el('pre', '', JSON.stringify(evidence, null, 2)));
        item.append(raw);
        list.append(item);
      }
      if (!list.childNodes.length) list.append(el('p', 'detail-meta', '当前采集范围没有更多证据。这不代表投递失败。'));
      evidenceSection.append(list);
      details.append(evidenceSection);
      if (selected.replyTo) {
        const reply = detailSection('回复关联 / REFERENCE');
        reply.append(el('p', 'detail-meta', str(selected.replyTo.reference, selected.replyTo.id)));
        if (selected.replyTo.reason) reply.append(el('p', 'detail-issue', selected.replyTo.reason));
        details.append(reply);
      }
    } else {
      const participants = detailSection(`参与者 / ${current.participants?.length || 0}`);
      for (const participant of current.participants || []) participants.append(personDetail(participant));
      details.append(participants);
      const evidence = detailSection('阅读提示');
      evidence.append(el('p', 'detail-meta', '点击一条消息，可查看它的发送与接收身份、账本事件、排队映射和原生受理证据。原生会话中未交换到 room 的内容不在这里展示。'));
      details.append(evidence);
    }
    if (current) {
      const meta = detailSection('Room 身份');
      const fields = el('dl', 'identity-grid');
      detailField(fields, 'Room', current.roomId || current.id);
      detailField(fields, 'Revision', current.revision);
      detailField(fields, 'Manifest', current.manifestHash);
      meta.append(fields);
      for (const issue of current.issues || []) meta.append(el('p', 'detail-issue', issueText(issue)));
      details.append(meta);
    }
    const diagnostics = state.snapshot?.diagnostics || [];
    if (diagnostics.length) {
      const section = detailSection(`采集提示 / ${diagnostics.length}`);
      for (const diagnostic of diagnostics) section.append(el('p', 'detail-issue', issueText(diagnostic)));
      details.append(section);
    }
  }

  function selectMessage(message) {
    const previous = state.selected?.id;
    state.selected = message;
    if (previous) state.cards.get(previous)?.classList.remove('selected');
    state.cards.get(message.id)?.classList.add('selected');
    renderDetails();
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); notify('已复制消息与准确身份'); }
    catch { notify('浏览器未允许剪贴板访问，可在详情中选择文字复制。'); }
  }

  async function jumpToReply(reply) {
    if (!reply.id) { notify(reply.reason || '原消息尚未采集，无法推断它的正文或投递状态。'); return; }
    const loaded = state.messages.find((message) => message.id === reply.id);
    if (loaded) {
      selectMessage(loaded);
      state.cards.get(reply.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const currentRoom = state.roomId;
    try {
      const result = await api(`/api/message?${new URLSearchParams({ id: reply.id })}`);
      if (currentRoom !== state.roomId) return;
      if (!result.message) throw new Error('原消息不在当前可读来源中。');
      state.reference = result.message;
      selectMessage(result.message);
      renderReference();
      $('reply-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { notify(error.message); }
  }

  async function loadMessages({ initial = false, more = false } = {}) {
    if (!state.roomId) {
      state.messages = []; state.scope = null; state.hasMore = false; state.nextCursor = null;
      renderTimeline(); return true;
    }
    const generation = ++state.generation;
    state.controller?.abort();
    state.controller = new AbortController();
    const signal = state.controller.signal;
    const oldHeight = $('timeline-scroll').scrollHeight;
    const oldTop = $('timeline-scroll').scrollTop;
    let usedCursor = false;
    let retryFresh = false;
    let loaded = false;
    $('load-more').disabled = true;
    $('load-more').textContent = '正在读取…';
    if (initial && !more) $('timeline').classList.add('loading');
    try {
      let messages = [];
      let cursor = more ? state.nextCursor : null;
      let result;
      const pages = more ? 1 : state.pages;
      for (let page = 0; page < pages; page += 1) {
        if (cursor) usedCursor = true;
        result = await api(`/api/messages?${params({ limit: 100, before: cursor })}`, { signal });
        messages = [...(result.messages || []), ...messages];
        cursor = result.nextCursor;
        if (!result.hasMore || !cursor) break;
      }
      if (generation !== state.generation) return false;
      const unique = new Map();
      for (const message of more ? [...messages, ...state.messages] : messages) unique.set(message.id, message);
      state.messages = [...unique.values()];
      state.nextCursor = result?.nextCursor || null;
      state.hasMore = Boolean(result?.hasMore && state.nextCursor);
      state.scope = result?.scope || null;
      if (more) state.pages += 1;
      if (state.selected) {
        const updated = state.messages.find((message) => message.id === state.selected.id);
        if (updated) state.selected = updated;
        else if (state.selected.id !== state.reference?.id) state.selected = null;
      }
      for (const message of state.messages) for (const status of message.statuses || []) state.statusCodes.add(statusCode(status));
      renderStatusOptions();
      renderTimeline({ scrollToBottom: initial && !more, preserveScroll: !more });
      if (more) requestAnimationFrame(() => { $('timeline-scroll').scrollTop = oldTop + $('timeline-scroll').scrollHeight - oldHeight; });
      renderDetails();
      setError('');
      loaded = true;
    } catch (error) {
      if (error.name !== 'AbortError' && generation === state.generation) {
        if (error.status === 409 && usedCursor) {
          state.pages = 1;
          state.nextCursor = null;
          state.hasMore = false;
          retryFresh = true;
          notice('历史分页的来源已变化，正在重新读取当前范围。');
        } else setError(error.message);
      }
    } finally {
      if (generation === state.generation) {
        $('timeline').classList.remove('loading');
        $('load-more').disabled = false;
        $('load-more').textContent = '加载更早的消息';
      }
    }
    if (retryFresh && generation === state.generation) {
      loaded = await loadMessages({ initial: true });
      if (loaded) {
        notify('历史来源已变化，已重新载入当前筛选范围。');
        if (!(state.snapshot?.sources || []).some((source) => source.available === false || source.error)) notice('');
      }
    }
    return loaded;
  }

  function selectRoom(id) {
    if (state.roomId === id && state.messages.length) return;
    state.roomId = id;
    state.messages = [];
    state.selected = null;
    state.reference = null;
    state.pages = 1;
    state.nextCursor = null;
    state.hasMore = false;
    state.scope = null;
    for (const control of ['filter-source', 'filter-participant', 'filter-status', 'search']) $(control).value = '';
    const url = new URL(location.href);
    url.hash = new URLSearchParams({ room: id }).toString();
    history.replaceState(null, '', url);
    renderRooms();
    renderHeading();
    renderTimeline();
    renderDetails();
    loadMessages({ initial: true });
  }

  async function refresh({ initial = false } = {}) {
    if (state.refreshing) { state.refreshAgain = true; return; }
    state.refreshing = true;
    try {
      state.snapshot = await api('/api/snapshot');
      const rooms = state.snapshot.rooms || [];
      if (!rooms.some((candidate) => candidate.id === state.roomId)) {
        state.roomId = '';
        state.selected = null;
        state.reference = null;
      }
      renderSources();
      renderRooms();
      if (!state.roomId && rooms.length) {
        selectRoom(rooms[0].id);
      } else {
        renderHeading();
        await loadMessages({ initial });
        renderDetails();
      }
      const unavailable = (state.snapshot.sources || []).filter((source) => source.available === false || source.stale || source.error);
      if (unavailable.length) notice(`${unavailable.length} 个来源读取受限。已保留可读记录；请查看左侧的采集时间与提示。`);
      else notice('');
      if (state.resync) { state.resync = false; notify('来源快照已重新同步。'); }
    } catch (error) { setError(error.message); }
    finally {
      state.refreshing = false;
      if (state.refreshAgain) { state.refreshAgain = false; scheduleRefresh(); }
    }
  }

  function scheduleRefresh() {
    clearTimeout(state.liveTimer);
    state.liveTimer = setTimeout(() => refresh(), 160);
  }

  function filterChanged() {
    state.pages = 1;
    state.reference = null;
    loadMessages({ initial: true });
  }

  async function exportScope(format) {
    if (!room()) return;
    const requestedRoomName = room().name;
    const query = params({ format });
    const button = format === 'json' ? $('export-json') : $('export-markdown');
    button.disabled = true;
    try {
      const response = await fetch(`/api/export?${query}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        let result;
        try { result = await response.json(); } catch { /* Fall back to status. */ }
        throw new Error(str(result?.error, `导出失败（HTTP ${response.status}）`));
      }
      const blob = await response.blob();
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      const safeName = str(requestedRoomName, 'dialogue').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 60);
      link.download = `${safeName}-filtered.${format === 'json' ? 'json' : 'md'}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('已导出当前 room 与筛选条件内的全部记录，包含证据引用。');
    } catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  }

  function connect() {
    const stream = new EventSource('/api/events', { withCredentials: true });
    stream.addEventListener('open', () => {
      $('connection').classList.remove('disconnected');
      $('connection').lastElementChild.textContent = '实时连接';
      if (state.snapshot) scheduleRefresh();
    });
    stream.addEventListener('change', scheduleRefresh);
    stream.addEventListener('reset', () => {
      state.resync = true;
      notice('来源或服务状态发生变化，正在重新同步当前视图。');
      scheduleRefresh();
    });
    stream.addEventListener('error', () => {
      $('connection').classList.add('disconnected');
      $('connection').lastElementChild.textContent = '等待重连';
      notice('实时连接中断，浏览器会自动重连。查看器重启后需用新访问链接打开；当前画面保留最后读取的记录。');
      scheduleRefresh();
    });
    window.addEventListener('pagehide', () => stream.close(), { once: true });
  }

  for (const id of ['filter-source', 'filter-participant', 'filter-status']) $(id).addEventListener('change', filterChanged);
  $('search').addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(filterChanged, 250); });
  $('search').addEventListener('search', filterChanged);
  $('clear-filters').addEventListener('click', () => {
    for (const id of ['filter-source', 'filter-participant', 'filter-status', 'search']) $(id).value = '';
    filterChanged();
  });
  $('load-more').addEventListener('click', () => loadMessages({ more: true }));
  $('export-json').addEventListener('click', () => exportScope('json'));
  $('export-markdown').addEventListener('click', () => exportScope('markdown'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); });
  refresh({ initial: true });
  connect();
})();
