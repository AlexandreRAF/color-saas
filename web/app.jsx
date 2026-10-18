import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

let csrf = '';
async function api(path, { method = 'GET', body, key } = {}) {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin',
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Requested-With': 'Color', 'X-CSRF-Token': csrf } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let result = null;
  if (response.status !== 204) {
    try { result = await response.json(); }
    catch { throw new Error('Não foi possível acessar o serviço. Aguarde e tente novamente.'); }
  }
  if (!response.ok) throw Object.assign(new Error(result.message || 'Não foi possível concluir. Tente novamente.'), { status: response.status });
  return result;
}
const states = { queued: 'Na fila', running: 'Pesquisando', retry_wait: 'Aguardando nova tentativa', completed: 'Pesquisa concluída',
  no_colors_found: 'Nenhuma cor encontrada', partial: 'Resultado incompleto', failed: 'Pesquisa não concluída', cancelled: 'Cancelada', expired: 'Prazo de espera esgotado' };
const stages = { queued: 'Aguardando uma vaga', running: 'Iniciando pesquisa', research: 'Consultando fontes',
  candidateReview: 'Revisando as cores', verification: 'Verificando evidências', databaseMatcher: 'Conferindo códigos' };
const active = state => ['queued', 'running', 'retry_wait'].includes(state);
const money = amount => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount / 100);
const date = value => new Date(value).toLocaleString('pt-BR');
const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };

function Field({ label, name, ...props }) {
  return <label>{label}<input name={name} {...props} /></label>;
}

function Authentication({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const titles = { login: 'Entre na sua oficina de cores', register: 'Crie sua conta', verify: 'Confirme seu e-mail',
    'forgot-password': 'Recupere sua conta', 'reset-password': 'Escolha uma nova senha', resend: 'Receba outro código' };
  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api(`/auth/${mode}`, { method: 'POST', body: data });
      if (mode === 'login') { csrf = result.csrf; await onLogin(); }
      else { setMessage(result.message); if (mode === 'register' || mode === 'resend') setMode('verify'); }
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  return <main className="auth-layout"><div className="auth-intro"><h1>A cor tem uma história.<br />Encontre as fontes.</h1>
    <p>Pesquise pinturas por fabricante, modelo e ano. Compare nomes, códigos e o que as evidências realmente confirmam.</p>
    <div className="paint-samples" aria-hidden="true"><i /><i /><i /><i /><i /></div>
    <p>Três créditos iniciais após confirmar seu e-mail. Cada pesquisa concluída custa um crédito.</p></div>
    <section className="auth-form"><h2>{titles[mode]}</h2><form onSubmit={submit}>
      <Field label="E-mail" name="email" type="email" autoComplete="email" maxLength={254} required />
      {['login', 'register', 'reset-password'].includes(mode) && <Field label="Senha · mínimo de 12 caracteres" name="password" type="password"
        minLength={12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />}
      {mode === 'verify' && <Field label="Código de 6 dígitos" name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required />}
      {mode === 'reset-password' && <Field label="Código recebido por e-mail" name="token" autoComplete="one-time-code" required />}
      <button disabled={busy}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Continuar'}</button>
    </form><p role="status">{message}</p><div className="auth-links">
      {Object.entries({ login: 'Já tenho uma conta', register: 'Criar conta', verify: 'Confirmar e-mail', resend: 'Reenviar código',
        'forgot-password': 'Esqueci minha senha', 'reset-password': 'Já recebi o código de recuperação' }).filter(([key]) => key !== mode)
        .map(([key, label]) => <button className="text-button" key={key} onClick={() => { setMode(key); setMessage(''); }}>{label}</button>)}
    </div></section></main>;
}

function ResearchForm({ user, refresh, navigate, notify }) {
  const [busy, setBusy] = useState(false);
  const submission = useRef(null);
  async function submit(event) {
    event.preventDefault(); setBusy(true); notify('');
    const body = Object.fromEntries(new FormData(event.currentTarget));
    body.manufacturingYear = Number(body.manufacturingYear);
    for (const key of ['paintFinish', 'predominantColor']) if (!body[key]) delete body[key];
    const serialized = JSON.stringify(body);
    if (submission.current?.payload !== serialized) submission.current = { payload: serialized, key: crypto.randomUUID() };
    try {
      const job = await api('/jobs', { method: 'POST', body, key: submission.current.key });
      submission.current = null; navigate(`job/${job.id}`); await refresh();
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  }
  return <section><div className="page-heading"><div><h1>Qual veículo vamos pesquisar?</h1><p>Use os dados do veículo para localizar as pinturas e suas fontes.</p></div>
    <span className="balance"><strong>{user.available}</strong> créditos disponíveis</span></div>
    {!user.verified && <p className="notice">Confirme seu e-mail para pesquisar ou comprar. <button className="text-button" onClick={() => navigate('verify')}>Confirmar agora</button></p>}
    <form className="research-form" onSubmit={submit}><div className="form-grid">
      <label>Tipo de veículo<select name="automobileType" defaultValue="car"><option value="car">Automóvel</option><option value="motorcycle">Motocicleta</option><option value="truck">Caminhão</option><option value="bus">Ônibus</option><option value="agricultural equipment">Máquina agrícola</option><option value="construction equipment">Máquina de construção</option></select></label>
      <Field label="Fabricante" name="brand" placeholder="Ex.: Volkswagen" maxLength={80} required />
      <Field label="Modelo" name="model" placeholder="Ex.: Gol" maxLength={100} required />
      <Field label="Ano de fabricação" name="manufacturingYear" type="number" min={1886} max={new Date().getFullYear() + 1} placeholder="Ex.: 2015" required />
      <Field label="País de comercialização" name="country" defaultValue="Brasil" maxLength={60} required />
      <Field label="Cor predominante (opcional)" name="predominantColor" placeholder="Ex.: vermelho" maxLength={60} />
      <label>Acabamento (opcional)<select name="paintFinish"><option value="">Todos os acabamentos</option><option value="solid">Sólido</option><option value="metallic">Metálico</option><option value="pearlescent">Perolizado</option><option value="matte">Fosco</option></select></label>
    </div><div className="billing-note"><strong>Uma pesquisa concluída, um crédito.</strong><p>Reservamos um crédito ao começar. Uma conclusão sem cores também custa um crédito. Falhas, resultados incompletos e pesquisas expiradas liberam a reserva. Você pode fechar esta página durante a pesquisa.</p>
      <p>Informe apenas dados do veículo. Não inclua placa, chassi, nomes ou informações pessoais.</p></div>
    <button disabled={busy || !user.verified || user.available < 1 || user.deletionRequested}>{busy ? 'Enviando pesquisa…' : 'Pesquisar por 1 crédito'}</button></form>
    <aside className="source-note"><h2>Uma referência para comparar</h2><p>O resultado apresenta evidências e incertezas. Confirme a identificação da tinta e faça uma amostra antes da aplicação.</p></aside></section>;
}

function Job({ id, notify, refresh }) {
  const [job, setJob] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [connection, setConnection] = useState('Conectando…');
  const terminal = useRef(false);
  useEffect(() => {
    let gone = false, timer, stream;
    terminal.current = false; setJob(null); setUnavailable(false);
    const receive = data => {
      if (gone) return;
      setJob(data);
      if (!active(data.state) && !terminal.current) { terminal.current = true; refresh().catch(() => {}); stream?.close(); clearTimeout(timer); }
    };
    const poll = async () => {
      try { const data = await api(`/jobs/${id}`); receive(data); }
      catch (e) { if (!gone) { notify(e.message); if ([401, 404, 410].includes(e.status)) { setUnavailable(true); stream?.close(); return; } } }
      if (!gone && !terminal.current) timer = setTimeout(poll, 5000);
    };
    poll();
    stream = new EventSource(`/api/jobs/${id}/events`);
    stream.addEventListener('snapshot', event => { receive(JSON.parse(event.data)); setConnection('Atualização ao vivo'); });
    stream.onerror = () => setConnection('Atualizando a cada 5 segundos');
    return () => { gone = true; stream.close(); clearTimeout(timer); };
  }, [id]);
  if (unavailable) return <p>Esta pesquisa não está disponível. Consulte seu histórico.</p>;
  if (!job) return <p role="status">Carregando pesquisa…</p>;
  async function cancel() {
    try { await api(`/jobs/${id}/cancel`, { method: 'POST', body: {} }); setJob(await api(`/jobs/${id}`)); await refresh(); }
    catch (e) { notify(e.message); }
  }
  const colors = job.result?.colors || [];
  const scope = { model_page: 'Página do modelo', model_catalog: 'Catálogo do modelo', model_display_label: 'Descrição de aparência',
    fleet_standard: 'Padrão da frota', shared_paint_possible: 'Possível pintura compartilhada', adjacent_year_lead: 'Referência de ano próximo', manufacturer_only: 'Referência do fabricante', unknown: 'Aplicação não confirmada' };
  return <section><div className="page-heading"><div><a href="#history">Voltar ao histórico</a><h1>{job.input.brand} {job.input.model} <span className="muted">{job.input.manufacturingYear}</span></h1>
    <p>{job.input.country} · {job.input.predominantColor || 'Todas as cores'}</p></div><strong className={`status status-${job.state}`}>{states[job.state]}</strong></div>
    <div className="progress-area" aria-live="polite"><h2>{stages[job.progress.stage] || states[job.state]}</h2>
      <dl className="counters"><div><dt>Páginas consultadas com sucesso</dt><dd>{job.progress.pagesFetched}</dd></div><div><dt>Buscas realizadas</dt><dd>{job.progress.browserUses}</dd></div>
      <div><dt>Chamadas de IA no total</dt><dd>{job.progress.aiCalls}</dd></div><div><dt>Chamadas de IA simultâneas agora</dt><dd>{job.progress.aiRunning}</dd></div></dl>
      {active(job.state) && <p>{connection}. A pesquisa continua se você sair.</p>}
      <p><strong>{job.credit === 'reserved' ? '1 crédito reservado.' : job.credit === 'consumed' ? '1 crédito consumido.' : 'Crédito liberado.'}</strong> {job.historyExpiresAt && `Disponível até ${date(job.historyExpiresAt)}.`}</p>
      {job.state === 'queued' && <button className="secondary" onClick={cancel}>Cancelar pesquisa</button>}</div>
    {job.state === 'partial' && <p className="notice">A pesquisa ficou incompleta. As referências disponíveis estão abaixo; a reserva foi liberada. Você pode iniciar outra pesquisa com uma nova reserva.</p>}
    {job.state === 'no_colors_found' && <p className="empty-state">A pesquisa foi concluída e não encontrou cores para esses critérios.</p>}
    {['failed', 'expired', 'cancelled'].includes(job.state) && <p className="empty-state">{states[job.state]}. Seu crédito está disponível para outra pesquisa.</p>}
    {colors.length > 0 && <><h2>Cores e evidências</h2><p>A ordem considera a confiança informada pela pesquisa. Mais links não significam maior precisão.</p>
      <div className="table-wrap"><table><thead><tr><th>Cor e código</th><th>Confiança e aplicação</th><th>Fontes e incertezas</th></tr></thead><tbody>{colors.map((color, index) => <tr key={index}>
        <td><strong>{color.name}</strong><p>{color.codes.join(', ') || 'Código não confirmado'}</p><small>{color.paintFinish.join(', ')}</small></td>
        <td><span>{({ high: 'Alta', medium: 'Média', low: 'Baixa', unknown: 'Não informada' })[color.confidence]}</span><p>{scope[color.applicabilityScope] || 'Aplicação não confirmada'}</p></td>
        <td><ul className="source-links">{color.sources.filter(safeUrl).map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}</a></li>)}</ul>
          <p>{color.uncertainty.unknown.length ? `Não confirmado: ${color.uncertainty.unknown.join(', ')}.` : ''} {color.uncertainty.conflicting.length ? `Evidências conflitantes: ${color.uncertainty.conflicting.join(', ')}.` : ''}
            {color.uncertainty.status === 'unverified' ? 'Sem confirmação final das características.' : ''}</p></td></tr>)}</tbody></table></div></>}
    {!active(job.state) && <p><a href={`/api/jobs/${id}/download`}>Baixar resultado em JSON</a> · <a href="#research">Iniciar uma nova pesquisa</a></p>}</section>;
}

function History({ notify }) {
  const [page, setPage] = useState(1), [data, setData] = useState(null);
  useEffect(() => { let live = true; api(`/jobs?page=${page}`).then(v => { if (live) setData(v); }).catch(e => notify(e.message)); return () => { live = false; }; }, [page]);
  return <section><h1>Suas pesquisas</h1><p>Pesquisas em andamento e resultados dentro do prazo de acesso.</p>
    {!data ? <p>Carregando…</p> : !data.jobs.length ? <p className="empty-state">Nenhuma pesquisa disponível. <a href="#research">Pesquisar um veículo</a></p> :
      <ul className="history-list">{data.jobs.map(job => <li key={job.id}><a href={`#job/${job.id}`}><strong>{job.input.brand} {job.input.model} · {job.input.manufacturingYear}</strong><span>{states[job.state]}</span><small>{date(job.createdAt)}</small></a></li>)}</ul>}
    <div className="pagination"><button className="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page}</span><button className="secondary" disabled={!data?.hasMore} onClick={() => setPage(page + 1)}>Próxima</button></div></section>;
}

function Purchases({ user, notify, refresh }) {
  const [packs, setPacks] = useState([]), [purchases, setPurchases] = useState([]), [busy, setBusy] = useState(false);
  const keys = useRef({});
  const load = async () => { setPurchases(await api('/purchases')); await refresh(); };
  useEffect(() => { api('/packs').then(setPacks).catch(e => notify(e.message)); load().catch(e => notify(e.message)); }, []);
  async function buy(pack) {
    setBusy(true);
    keys.current[pack.id] ||= crypto.randomUUID();
    try {
      const purchase = await api('/purchases', { method: 'POST', body: { packId: pack.id }, key: keys.current[pack.id] });
      const url = new URL(purchase.url);
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('Endereço de pagamento inválido.');
      window.location.assign(url.href);
    } catch (e) { notify(e.message); setBusy(false); }
  }
  return <section><h1>Créditos para as próximas cores</h1><p>Pagamento em reais no Checkout da Stripe. Os créditos entram após a confirmação do pagamento.</p>
    <div className="packs">{packs.map(pack => <article key={pack.id}><h2>{pack.credits} créditos</h2><p className="price">{money(pack.amount)}</p><p>Até {pack.credits} pesquisas concluídas.</p><button onClick={() => buy(pack)} disabled={busy || !user.verified || user.deletionRequested}>Comprar {pack.credits} créditos</button></article>)}</div>
    {!user.verified && <p className="notice">Confirme seu e-mail para comprar créditos.</p>}
    <h2>Compras e ajustes</h2><button className="secondary" onClick={() => load().catch(e => notify(e.message))}>Atualizar pagamentos</button>
    <p>Voltar do pagamento não confirma a compra. Pagamentos em processamento podem levar mais tempo. Reembolsos e contestações ajustam o saldo; créditos já usados podem gerar um débito.</p>
    {purchases.length ? <ul className="history-list">{purchases.map(p => <li key={p.id}><strong>{p.credits} créditos · {money(p.amount)}</strong><p>{({ pending: 'Aguardando pagamento', fulfilled: 'Pagamento confirmado', expired: 'Pagamento expirado', review: 'Em conciliação' })[p.state]} · {date(p.created_at)}</p>
      {p.withheld_credits > 0 && <p>{p.withheld_credits} créditos indisponíveis por reembolso ou contestação.</p>}</li>)}</ul> : <p>Nenhuma compra registrada.</p>}</section>;
}

function Account({ user, notify, logout }) {
  const [ledger, setLedger] = useState([]), [deleting, setDeleting] = useState(false);
  useEffect(() => { api('/credits').then(setLedger).catch(e => notify(e.message)); }, []);
  async function request(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try { const result = await api('/account/privacy-requests', { method: 'POST', body }); notify(result.message); if (body.kind === 'deletion') await logout(false); }
    catch (e) { notify(e.message); }
  }
  return <section><h1>Sua conta</h1><p>{user.email}</p><p>{user.available} créditos disponíveis · {user.reserved} reservados · {user.debt} em débito</p>
    <p><a href="/api/account/export">Exportar meus dados</a> · <a href="/privacidade.html">Política de privacidade</a></p>
    <button className="secondary" onClick={() => logout(true)}>Sair de todos os dispositivos</button>
    <h2>Corrigir dados</h2><form onSubmit={request}><input type="hidden" name="kind" value="correction" /><label>Descreva a correção<textarea name="details" maxLength={500} required /></label><button className="secondary">Solicitar correção</button></form>
    <h2>Excluir conta</h2><p>O acesso será encerrado. Pesquisas aceitas terminam antes da remoção dos resultados. Registros financeiros seguem seu prazo de retenção.</p>
    {!deleting ? <button className="secondary" onClick={() => setDeleting(true)}>Solicitar exclusão</button> : <form onSubmit={request}><input type="hidden" name="kind" value="deletion" /><button>Confirmar solicitação de exclusão</button></form>}
    <h2>Movimentações de créditos</h2><ul className="history-list">{ledger.map((entry, i) => <li key={i}>
      <strong>{({ grant: 'Créditos iniciais', purchase: 'Compra', reservation: 'Reserva para pesquisa', consumption: 'Pesquisa concluída', release: 'Reserva liberada', reversal: 'Reversão de pagamento', dispute_hold: 'Créditos retidos em contestação', dispute_restore: 'Créditos restaurados' })[entry.kind]}</strong>
      <p>Saldo: {entry.balance_delta > 0 ? '+' : ''}{entry.balance_delta} · Reservas: {entry.reserved_delta > 0 ? '+' : ''}{entry.reserved_delta} · {date(entry.created_at)}</p></li>)}</ul></section>;
}

function Verify({ user, notify, logout }) {
  async function verify(event) {
    event.preventDefault();
    try { const code = new FormData(event.currentTarget).get('code'); const result = await api('/auth/verify', { method: 'POST', body: { email: user.email, code } }); notify(result.message); await logout(false); }
    catch (e) { notify(e.message); }
  }
  return <section><h1>Confirme seu e-mail</h1><p>Informe o código enviado para {user.email}.</p><form onSubmit={verify}><Field label="Código de 6 dígitos" name="code" pattern="[0-9]{6}" inputMode="numeric" required /><button>Confirmar</button></form>
    <button className="text-button" onClick={() => api('/auth/resend', { method: 'POST', body: { email: user.email } }).then(r => notify(r.message)).catch(e => notify(e.message))}>Reenviar código</button></section>;
}

function App() {
  const [user, setUser] = useState(null), [loading, setLoading] = useState(true), [message, notify] = useState('');
  const [route, setRoute] = useState(location.hash.slice(1) || 'research');
  const navigate = value => { location.hash = value; };
  async function refresh() { const account = await api('/me'); csrf = account.csrf; setUser(account); }
  useEffect(() => { refresh().catch(e => { if (e.status !== 401) notify(e.message); }).finally(() => setLoading(false));
    const change = () => { setRoute(location.hash.slice(1) || 'research'); notify(''); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  async function logout(all) {
    try { await api('/logout', { method: 'POST', body: { all } }); } catch (e) { if (e.status !== 401) notify(e.message); }
    csrf = ''; setUser(null);
  }
  return <><a className="skip-link" href="#content" onClick={event => { event.preventDefault(); document.getElementById('content')?.focus(); }}>Ir para o conteúdo</a><header className="site-header"><a className="brand" href="/">Color<span>Pesquisa de pintura automotiva</span></a>
    {user && <button className="text-button" onClick={() => logout(false)}>Sair</button>}</header>
    {message && <p className="notice global-message" role="alert">{message}</p>}
    {loading ? <main id="content" tabIndex={-1}><p>Carregando sua conta…</p></main> : !user ? <div id="content" tabIndex={-1}><Authentication onLogin={async () => { await refresh(); notify(''); }} /></div> :
      <div className="app-layout"><nav aria-label="Aplicação"><a href="#research" aria-current={route === 'research' ? 'page' : undefined}>Nova pesquisa</a><a href="#history" aria-current={route === 'history' ? 'page' : undefined}>Histórico</a><a href="#purchases" aria-current={route === 'purchases' ? 'page' : undefined}>Comprar créditos</a><a href="#account" aria-current={route === 'account' ? 'page' : undefined}>Minha conta</a>
        <p>{user.available} disponíveis<br />{user.reserved} reservados</p></nav><main id="content" tabIndex={-1}>
        {user.debt > 0 && <p className="notice">Há um débito de {user.debt} créditos por ajustes de pagamentos. Novas compras cobrem primeiro esse débito.</p>}
        {user.available <= user.lowCreditThreshold && route !== 'purchases' && <p className="low-credit">{user.available ? 'Seus créditos estão acabando.' : 'Você não tem créditos disponíveis.'} <a href="#purchases">Ver pacotes de créditos</a></p>}
        {route.startsWith('job/') ? <Job id={route.slice(4)} notify={notify} refresh={refresh} /> : route === 'history' ? <History notify={notify} /> : route === 'purchases' ? <Purchases user={user} notify={notify} refresh={refresh} />
          : route === 'account' ? <Account user={user} notify={notify} logout={logout} /> : route === 'verify' ? <Verify user={user} notify={notify} logout={logout} />
            : <ResearchForm user={user} refresh={refresh} navigate={navigate} notify={notify} />}</main></div>}
    <footer><a href="/sobre.html">Sobre a pesquisa</a><a href="/privacidade.html">Privacidade</a><a href="/termos.html">Termos e créditos</a></footer></>;
}

createRoot(document.getElementById('root')).render(<App />);
