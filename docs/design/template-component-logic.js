// Authoritative reference: the v2 template's embedded component logic
// (data + renderVals + vm). Source of truth for scenarios, copy, and bindings.
<script type="text/x-dc" data-dc-script data-props="{
  &quot;$preview&quot;: {&quot;width&quot;: &quot;100%&quot;, &quot;height&quot;: 900},
  &quot;theme&quot;: {&quot;editor&quot;: &quot;enum&quot;, &quot;options&quot;: [&quot;light&quot;, &quot;dark&quot;], &quot;default&quot;: &quot;light&quot;, &quot;tsType&quot;: &quot;string&quot;, &quot;section&quot;: &quot;Appearance&quot;},
  &quot;scenario&quot;: {&quot;editor&quot;: &quot;enum&quot;, &quot;options&quot;: [&quot;normal&quot;, &quot;all-caught-up&quot;, &quot;no-team&quot;, &quot;brand-new&quot;, &quot;offline&quot;, &quot;no-api-key&quot;, &quot;signed-out&quot;], &quot;default&quot;: &quot;normal&quot;, &quot;tsType&quot;: &quot;string&quot;, &quot;section&quot;: &quot;State&quot;}
}">
class Component extends DCLogic {
  state = {
    screen: 'catchup',
    theme: null,
    scenarioOverride: null,
    expandedId: 's1',
    caughtUp: false,
    inviteOpen: false,
    inviteCopied: false,
    menuOpen: false,
    confirmDelete: false,
    roadmapOpen: false,
    roadmapState: 'idle',
    projectId: 'p1',
    paused: {},
    removed: {},
    syncing: false,
    regenerating: false,
    copiedAI: false,
    apiKey: 'sk-ant-api03-mB7v…kQ2',
    feedPerson: 'All', feedProject: 'All projects', feedTool: 'All tools',
    toast: null,
  };

  componentDidMount() { this.applyTheme(); }
  componentDidUpdate() { this.applyTheme(); }
  applyTheme() {
    const t = this.state.theme ?? this.props.theme ?? 'light';
    document.body.dataset.theme = t;
  }
  showToast(msg) {
    this.setState({ toast: msg });
    clearTimeout(this._tt);
    this._tt = setTimeout(() => this.setState({ toast: null }), 1800);
  }

  data() {
    const S = [
      { id:'s1', author:'Andrew', who:'andrew', tool:'Claude Code', project:'membridge', pid:'p1', day:'Today', time:'2h ago', wip:false,
        summary:'Shipped the unified feed API — local and teammate sessions now merge into one cursor-paginated endpoint',
        ask:'Merge the local session log and the teamsync feed into a single API the dashboard can page through. Keep ordering stable when the two machines\u2019 clocks disagree.',
        files:['server/api/feed.ts','lib/teamsync.js','lib/feed-merge.js','lib/cursor.js','test/feed-merge.test.js'],
        todos:[['Design merge cursor (lamport + wall clock)',1],['Merge iterator over both stores',1],['Cursor pagination + resume token',1],['Dedupe sessions synced from both sides',1],['Backfill test fixtures',1],['Wire dashboard to new endpoint',1]],
        checkpoints:['Settled on a hybrid cursor: lamport counter first, wall clock as tiebreaker','Wrote the two-store merge iterator; found and fixed a dupe when a session syncs from both machines','Added resume tokens so the feed can page backwards','Ported the dashboard fetch layer; deleted the old /local and /team endpoints','Full test pass, including the clock-skew fixtures'] },
      { id:'s2', author:'Andrew', who:'andrew', tool:'Codex', project:'membridge-daemon', pid:'p2', day:'Today', time:'4h ago', wip:true,
        summary:'Supabase migration — schema and auth are wired, the sync writer still points at the old store',
        ask:'Move team sync storage off the JSON blob store onto Supabase so two people can\u2019t clobber each other\u2019s writes.',
        files:['daemon/store/supabase.ts','daemon/store/schema.sql','daemon/auth.ts'],
        todos:[['Schema: teams, projects, sessions, checkpoints',1],['Row-level security per team',1],['Auth token exchange in daemon',1],['Point sync writer at Supabase',0],['Backfill existing team data',0]],
        checkpoints:['Schema drafted; sessions are append-only, checkpoints reference them','RLS policies pass the two-team isolation test','Daemon exchanges the app token for a scoped service key'] },
      { id:'s3', author:'Andrew', who:'andrew', tool:'Claude Code', project:'membridge', pid:'p1', day:'Yesterday', time:'Yesterday, 6:12 PM', wip:false,
        summary:'Fixed the distiller dropping final todo state when a session ends mid-write',
        ask:'Sessions killed mid-write lose their last todo update — the memory says 4/6 when it was really 6/6. Find it and fix it.',
        files:['daemon/distill.js','daemon/session-tail.js'],
        todos:[['Reproduce with a killed session',1],['Flush todo state on tail close',1]], checkpoints:null },
      { id:'s4', author:'Andrew', who:'andrew', tool:'Codex', project:'membridge', pid:'p1', day:'Yesterday', time:'Yesterday, 11:05 AM', wip:false,
        summary:'Sync pill now retries with backoff and surfaces daemon crashes instead of going quietly stale',
        ask:'The menubar pill sometimes shows \u201csynced\u201d hours after the daemon died. Make failure visible.',
        files:['app/menubar/pill.tsx','daemon/heartbeat.js','app/ipc.ts'],
        todos:[['Heartbeat over IPC',1],['Backoff retry',1],['Crash state in pill',1],['Click-to-restart daemon',1]], checkpoints:null },
      { id:'m1', author:'Marco', who:'marco', tool:'Claude Code', project:'membridge', pid:'p1', day:'Yesterday', time:'Yesterday, 3:12 PM', wip:false, mine:true,
        summary:'Rebuilt the catch-up ranking — sessions sort by impact score instead of pure recency',
        ask:'A one-line typo fix shouldn\u2019t outrank the feed API rewrite just because it\u2019s newer. Rank by what matters.',
        files:['lib/rank.js','lib/impact.js','test/rank.test.js'],
        todos:[['Impact score: files \u00d7 todos \u00d7 checkpoint depth',1],['Recency decay curve',1],['Pin in-progress work to top',1]], checkpoints:null },
      { id:'m2', author:'Marco', who:'marco', tool:'Claude Code', project:'membridge-site', pid:'p3', day:'Monday', time:'Mon, 4:40 PM', wip:false, mine:true,
        summary:'Drafted the landing page narrative and wired the waitlist form',
        ask:'Write the landing story around the catch-up moment, not the feature list.',
        files:['site/index.astro','site/waitlist.ts'],
        todos:[['Hero copy',1],['Waitlist endpoint',1],['OG image placeholder',1]], checkpoints:null },
    ];
    const P = [
      { id:'p1', name:'membridge', glyph:'mb', path:'~/code/membridge', shared:true,
        lastTouched:'2h ago · Andrew', delta:'3 sessions · 14 files · 2 open todos since you last looked',
        activeNow:false, activeLabel:'', statSessions:'11', statFiles:'38', statTodos:'2',
        todos:[{t:'Rotate the Anthropic API keys', who:'waiting on you', you:true},{t:'QA feed pagination on 1k-session projects', who:'unclaimed', you:false}] },
      { id:'p2', name:'membridge-daemon', glyph:'dm', path:'~/code/membridge-daemon', shared:true,
        lastTouched:'4h ago · Andrew', delta:'1 session · 6 files · 2 open todos since you last looked',
        activeNow:true, activeLabel:'Andrew is in a session here now', statSessions:'6', statFiles:'19', statTodos:'2',
        todos:[{t:'Point sync writer at Supabase', who:'Andrew · in progress', you:false},{t:'Backfill migration for existing teams', who:'unclaimed', you:false}] },
      { id:'p3', name:'membridge-site', glyph:'st', path:'~/code/membridge-site', shared:false,
        lastTouched:'Mon · you', delta:'No changes since you last looked',
        activeNow:false, activeLabel:'', statSessions:'2', statFiles:'5', statTodos:'0', todos:[] },
    ];
    return { S, P };
  }

  vm(s) {
    const expanded = this.state.expandedId === s.id;
    const done = s.todos.filter(t => t[1]).length;
    return {
      id: s.id, author: s.author, tool: s.tool, project: s.project, time: s.time,
      wip: s.wip, summary: s.summary, ask: s.ask, files: s.files,
      initial: s.author[0],
      color: s.who === 'marco' ? 'var(--marco)' : 'var(--andrew)',
      expanded, chev: expanded ? 'rotate(180deg)' : 'none',
      toggle: () => this.setState({ expandedId: expanded ? null : s.id }),
      hasCheckpoints: !!(s.checkpoints && s.checkpoints.length),
      checkpoints: (s.checkpoints || []).map((t, i) => ({ n: String(i + 1).padStart(2, '0'), t })),
      todoLabel: done + ' of ' + s.todos.length + ' todos done',
      todoPct: Math.round(100 * done / s.todos.length) + '%',
      todoBar: s.wip ? 'var(--amber)' : 'var(--grad)',
      todoItems: s.todos.map(([t, d]) => ({
        t, mark: d ? '✓' : '○',
        color: d ? 'var(--text3)' : 'var(--text)',
        deco: d ? 'line-through' : 'none',
      })),
    };
  }

  dayGroups(list) {
    const order = [];
    const map = {};
    list.forEach(s => {
      if (!map[s.day]) { map[s.day] = []; order.push(s.day); }
      map[s.day].push(this.vm(s));
    });
    return order.map(label => ({ label, items: map[label] }));
  }

  renderVals() {
    const { S, P } = this.data();
    const st = this.state;
    const scenario = st.scenarioOverride ?? this.props.scenario ?? 'normal';
    const isAuth = scenario === 'signed-out';
    const isOffline = scenario === 'offline';
    const noTeam = scenario === 'no-team';
    const fresh = scenario === 'brand-new';
    const noKey = scenario === 'no-api-key' || !st.apiKey.trim();
    const caughtUp = scenario === 'all-caught-up' || st.caughtUp;

    const nav = (screen) => () => this.setState({ screen, inviteOpen:false, menuOpen:false, confirmDelete:false });

    const newSessions = S.filter(s => !s.mine && ['s1','s2','s3','s4'].includes(s.id));
    const headlineSrc = isOffline ? S.filter(s => s.mine && s.id === 'm1') : newSessions;
    const headlines = headlineSrc.map(s => this.vm(s));

    const chip = (val, current, setter) => {
      const active = val === current;
      return {
        label: val,
        click: () => this.setState({ [setter]: val }),
        border: active ? 'transparent' : 'var(--border)',
        bg: active ? 'var(--grad)' : 'transparent',
        color: active ? '#fff' : 'var(--text2)',
        weight: active ? '600' : '400',
        shadow: active ? 'var(--shadow-accent)' : 'none',
      };
    };
    const feedChips = [
      ...['All','Marco','Andrew'].map(v => chip(v, st.feedPerson, 'feedPerson')),
      ...['All projects','membridge','membridge-daemon','membridge-site'].map(v => chip(v, st.feedProject, 'feedProject')),
      ...['All tools','Claude Code','Codex'].map(v => chip(v, st.feedTool, 'feedTool')),
    ];
    const feedList = S.filter(s =>
      (st.feedPerson === 'All' || s.author === st.feedPerson) &&
      (st.feedProject === 'All projects' || s.project === st.feedProject) &&
      (st.feedTool === 'All tools' || s.tool === st.feedTool));

    const projects = P.map(p => ({
      ...p,
      local: !p.shared,
      hasTodos: p.todos.length > 0,
      todos: p.todos.map(t => ({ t: t.t, who: t.who, whoColor: t.you ? 'var(--amber)' : 'var(--text3)' })),
      open: () => this.setState({ screen:'project', projectId:p.id, menuOpen:false, roadmapOpen:false, roadmapState:'idle' }),
    }));

    const proj = P.find(p => p.id === st.projectId) || P[0];
    const projGroups = this.dayGroups(S.filter(s => s.pid === proj.id));

    const settingsProjects = P.filter(p => !st.removed[p.id]).map(p => ({
      name: p.name,
      path: p.path,
      badge: p.shared ? 'shared' : 'local only',
      pauseLabel: st.paused[p.id] ? 'Resume' : 'Pause',
      togglePause: () => this.setState(s2 => ({ paused: { ...s2.paused, [p.id]: !s2.paused[p.id] } })),
      removeLabel: st.confirmDelete === p.id ? 'Really delete?' : 'Delete',
      remove: () => {
        if (st.confirmDelete === p.id) { this.setState(s2 => ({ removed: { ...s2.removed, [p.id]: true }, confirmDelete:false })); this.showToast('Project removed for the whole team'); }
        else this.setState({ confirmDelete: p.id });
      },
    }));

    const theme = st.theme ?? this.props.theme ?? 'light';

    const title = caughtUp ? 'All clear' : (noTeam || fresh ? 'Good morning, Marco' : 'While you were out');
    const words = title.split(' ');
    const catchupTitleAccent = words.pop();
    const catchupTitlePre = words.join(' ');

    return {
      isAuth, isApp: !isAuth,
      isCatchup: st.screen === 'catchup',
      isFeed: st.screen === 'feed',
      isProject: st.screen === 'project',
      isSettings: st.screen === 'settings',
      navCatchup: nav('catchup'), navFeed: nav('feed'), navSettings: nav('settings'),
      signIn: () => this.setState({ scenarioOverride: 'normal', screen: 'catchup' }),
      logOut: () => this.setState({ scenarioOverride: 'signed-out' }),
      themeGlyph: theme === 'dark' ? '☀' : '☾',
      toggleTheme: () => this.setState({ theme: theme === 'dark' ? 'light' : 'dark' }),

      syncLabel: isOffline ? 'Offline' : (st.syncing ? 'Syncing' : 'Synced'),
      syncDotStyle: {
        width:7, height:7, borderRadius:'50%', flex:'none',
        background: isOffline ? 'var(--amber)' : 'var(--green)',
        animation: st.syncing ? 'mbPulse .8s ease infinite' : 'mbPulse 3s ease infinite',
      },
      syncNow: () => {
        if (isOffline) { this.showToast('Still unreachable — retrying in the background'); return; }
        this.setState({ syncing:true });
        setTimeout(() => this.setState({ syncing:false }), 1200);
      },

      inviteOpen: st.inviteOpen,
      toggleInvite: () => this.setState(s2 => ({ inviteOpen: !s2.inviteOpen, inviteCopied:false })),
      inviteCopyLabel: st.inviteCopied ? 'Copied' : 'Copy',
      copyInvite: () => { try { navigator.clipboard.writeText('https://membridge.app/j/9kf2-xq7'); } catch(e){} this.setState({ inviteCopied:true }); },

      isOffline,
      catchupTitlePre, catchupTitleAccent,
      lastViewedLabel: 'yesterday, 3:40 PM',
      showAnchorLine: !noTeam && !fresh && !caughtUp,
      showMarkCaughtUp: !noTeam && !fresh && !caughtUp && !isOffline,
      markCaughtUp: () => { this.setState({ caughtUp:true }); this.showToast('Caught up — Andrew will see it'); },
      undoCaughtUp: () => this.setState({ caughtUp:false }),
      canUndoCaughtUp: st.caughtUp,
      caughtUpAt: st.caughtUp ? 'just now' : 'yesterday, 6:12 PM',
      isCaughtUpState: caughtUp && !noTeam && !fresh,
      isNoTeam: noTeam,
      isFresh: fresh,
      showCatchupBody: !caughtUp && !noTeam && !fresh,
      showBriefing: !noKey && !isOffline && !caughtUp && !noTeam && !fresh,
      showNoKeyHint: noKey && !isOffline && !caughtUp && !noTeam && !fresh,
      briefingOpacity: st.regenerating ? 0.35 : 1,
      regenLabel: st.regenerating ? 'Thinking…' : 'Regenerate',
      regenStyle: { display:'inline-block', animation: st.regenerating ? 'mbSpin .8s linear infinite' : 'none' },
      regenerate: () => { this.setState({ regenerating:true }); setTimeout(() => this.setState({ regenerating:false }), 1100); },
      headlinesTitle: isOffline ? 'Your local sessions' : 'What happened · ' + headlines.length + ' sessions',
      headlines,
      projects,

      feedChips,
      feedGroups: this.dayGroups(feedList),

      proj,
      projGroups,
      projPaused: !!st.paused[proj.id],
      pauseLabel: st.paused[proj.id] ? 'Resume watching' : 'Pause watching',
      togglePause: () => this.setState(s2 => ({ paused: { ...s2.paused, [proj.id]: !s2.paused[proj.id] }, menuOpen:false })),
      menuOpen: st.menuOpen,
      toggleMenu: () => this.setState(s2 => ({ menuOpen: !s2.menuOpen, confirmDelete:false })),
      menuClose: () => this.setState({ menuOpen:false }),
      confirmingDelete: st.confirmDelete === true,
      notConfirmingDelete: st.confirmDelete !== true,
      askDelete: () => this.setState({ confirmDelete:true }),
      cancelDelete: () => this.setState({ confirmDelete:false }),
      doDelete: () => { this.setState({ menuOpen:false, confirmDelete:false, screen:'catchup' }); this.showToast('Project and its team memory deleted'); },
      copyAiLabel: st.copiedAI ? 'Copied ✓' : 'Copy for AI',
      copyForAI: () => {
        try { navigator.clipboard.writeText('# ' + proj.name + ' — MemBridge context\n\nRecent sessions, state and open todos…'); } catch(e){}
        this.setState({ copiedAI:true }); this.showToast('Project context copied — paste into any AI tool');
        setTimeout(() => this.setState({ copiedAI:false }), 1800);
      },
      roadmapOpen: st.roadmapOpen,
      roadmapChev: st.roadmapOpen ? 'rotate(90deg)' : 'none',
      toggleRoadmap: () => this.setState(s2 => ({ roadmapOpen: !s2.roadmapOpen })),
      roadmapIdle: st.roadmapState === 'idle',
      roadmapLoading: st.roadmapState === 'loading',
      roadmapDone: st.roadmapState === 'done',
      genRoadmap: () => { this.setState({ roadmapState:'loading' }); setTimeout(() => this.setState({ roadmapState:'done' }), 1400); },

      settingsProjects,
      apiKey: st.apiKey,
      onApiKey: (e) => this.setState({ apiKey: e.target.value }),
      keyStatus: st.apiKey.trim() ? 'active' : 'no key',
      keyStatusColor: st.apiKey.trim() ? 'var(--green)' : 'var(--text3)',

      toast: st.toast,
    };
  }
}
</script>