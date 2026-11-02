/* Internship Watch, demo build.
   The real dashboard talks to a Cloudflare Worker API behind Cloudflare Access. Here every
   /api call is answered from sample data held in memory, so anyone can open it with no sign-in.
   Changes (applied, hidden, deleted, companies added, budgets edited...) last until the page
   reloads and are never sent anywhere. Searching is turned off: it would spend Claude credits. */
(function () {
  "use strict";

  function day(offset) {
    var d = new Date(); d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }
  function at(offsetDays, hour) {
    var d = new Date(); d.setDate(d.getDate() + offsetDays); d.setUTCHours(hour || 13, 0, 0, 0);
    return d.toISOString();
  }

  var nextId = 100;
  function posting(o) {
    return Object.assign({
      id: nextId++, company_name: "", title: "", url: "https://example.com/careers/job",
      source_name: "Company careers page", locations: ["United States"], location_match: "match",
      first_seen: day(0), posted_date: day(-1), status: "open", applied: 0, user_status: null,
      public_hidden: 0, visitor_reports: 0, note: null, verified_via: "feed", verified_at: day(0),
      status_note: null, matched_title: "Product Manager Intern"
    }, o);
  }

  var data = {
    today: [
      posting({ company_name: "Northwind Labs", title: "Product Manager Intern, Summer 2027 (MBA)", locations: ["Seattle, WA"], source_name: "Greenhouse feed" }),
      posting({ company_name: "Contoso Cloud", title: "MBA Product Management Intern", locations: ["Austin, TX", "Remote, US"], source_name: "Workday", verified_via: "structured" }),
      posting({ company_name: "Fabrikam AI", title: "Associate Product Manager Intern", locations: ["San Francisco, CA"], source_name: "Lever feed", verified_via: null, verified_at: null, status_note: "Not yet confirmed" }),
      posting({ company_name: "Tailspin Games", title: "Product Manager Intern, Live Services", locations: ["Los Angeles, CA"], source_name: "Ashby feed" }),
      posting({ company_name: "Wide World Retail", title: "Product Strategy Intern (MBA)", locations: ["Bentonville, AR"], matched_title: "Strategy Intern", source_name: "Discovery search", verified_via: "browser" })
    ],
    earlier: [
      posting({ company_name: "Litware Semiconductor", title: "Technical Product Manager Intern", locations: ["Santa Clara, CA"], first_seen: day(-3), posted_date: day(-4), applied: 1, source_name: "Workday" }),
      posting({ company_name: "Adatum Payments", title: "Product Management Intern, Summer 2027", locations: ["New York, NY"], first_seen: day(-5), posted_date: day(-6), source_name: "Greenhouse feed" }),
      posting({ company_name: "Proseware", title: "MBA Product Manager Intern", locations: ["Austin, TX"], first_seen: day(-6), source_name: "SmartRecruiters", verified_via: "mirror" }),
      posting({ company_name: "Coho Health", title: "Product Manager Intern", locations: ["Boston, MA"], first_seen: day(-8), source_name: "Lever feed", status: "closed", status_note: "Posting closed" }),
      posting({ company_name: "Blue Yonder Airlines", title: "Product Manager Intern, Digital", locations: ["Dallas, TX"], first_seen: day(-9), source_name: "MBA career board", visitor_reports: 1 }),
      posting({ company_name: "Woodgrove Bank", title: "Product Management Associate Intern", locations: ["London, UK"], location_match: "outside", first_seen: day(-10), source_name: "Workday" }),
      posting({ company_name: "Trey Research", title: "Product Manager Intern", locations: ["Remote, US"], first_seen: day(-12), source_name: "Email alert", verified_via: "user", user_status: "open" })
    ],
    archived: [
      posting({ company_name: "Alpine Ski House", title: "Product Intern", locations: ["Denver, CO"], first_seen: day(-20), status: "closed", archive_reason: "Deleted by you" })
    ],
    sources: [
      { id: 1, name: "Greenhouse job feeds", url: "https://boards.greenhouse.io", kind: "Company career sites", found_count: 14, covers: "Northwind Labs, Adatum Payments", last_checked: day(0), notes: "ok" },
      { id: 2, name: "Workday career sites", url: "https://www.myworkday.com", kind: "Company career sites", found_count: 9, covers: "Contoso Cloud, Litware Semiconductor", last_checked: day(0), notes: "ok" },
      { id: 3, name: "Lever job feeds", url: "https://jobs.lever.co", kind: "Company career sites", found_count: 6, covers: "Fabrikam AI, Coho Health", last_checked: day(0), notes: "ok" },
      { id: 4, name: "Public LinkedIn job pages", url: "https://www.linkedin.com/jobs", kind: "Job boards", found_count: 4, covers: "", last_checked: day(-1), notes: "signed-out pages only" },
      { id: 5, name: "MBA PM internship tracker", url: "https://example.com/tracker", kind: "Trackers and aggregators", found_count: 7, covers: "", last_checked: day(-1), notes: "community list" },
      { id: 6, name: "MBA career office board", url: "https://example.edu/careers", kind: "School job boards", found_count: 3, covers: "", last_checked: day(-2), notes: "" },
      { id: 7, name: "PM recruiting timeline", url: "https://example.com/timeline", kind: "Timing guides", found_count: 0, covers: "", last_checked: day(-7), notes: "when roles usually open" }
    ],
    careersPages: [
      { name: "Tailspin Games", status: "working", method: "browser_run", last_checked: at(0, 12) },
      { name: "Wide World Retail", status: "changed", method: "browser_run", last_checked: at(0, 12) },
      { name: "Blue Yonder Airlines", status: "unchanged", method: "backup", last_checked: at(0, 12) },
      { name: "Litware Semiconductor", status: "blocked", method: "backup", last_checked: at(-1, 12), last_error: "Bot check on the page", flagged: true }
    ],
    feedback: [
      { id: 1, kind: "dead_link", status: "new", message: "The Apply link for this one goes to a 404.", posting_id: null, created_at: at(0, 15) },
      { id: 2, kind: "suggestion", status: "read", message: "Could the board show which roles are sponsoring visas?", posting_id: null, created_at: at(-2, 18) },
      { id: 3, kind: "closed", status: "new", message: "This role stopped taking applications yesterday.", posting_id: null, created_at: at(-1, 20) }
    ],
    proposals: [
      { id: 1, kind: "company", payload: { action: "add", name: "Margie's Travel", reason: "Posted a PM intern role last cycle in October." } },
      { id: 2, kind: "careers_repair", payload: { company_name: "Litware Semiconductor", new_url: "https://example.com/litware/careers", reason: "The old careers page now shows a bot check." } }
    ],
    budgets: {
      settings: {
        daily_usd_budget: 1.5, monthly_usd_budget: 15, daily_search_budget: 4,
        search_limit_per_run: 3, search_limit_per_company: 1, browser_checks_per_run: 4,
        public_feedback_daily_limit: 20,
        share_discovery: 0.55, share_scout: 0.2, share_classification: 0.15, share_improvement: 0.1,
        model_discovery: "sonnet", model_scout: "sonnet", model_classification: "haiku", model_improvement: "sonnet"
      },
      usage: { daily: { searches: 2, usd: 0.42 }, weekly: { usd: 2.1 }, monthly: { usd: 6.8 } },
      resets: { daily: { reset_at: at(1, 5) }, weekly: null },
      forecast: { weekly_usd: 2.9, monthly_usd: 11.4 },
      public_site: { feedback_daily_limit: 20, feedback_today: 3, board_views_today: 41 },
      changes: [
        { changed_at: at(-3, 16), field: "daily_search_budget", old_value: 5, new_value: 4 },
        { changed_at: at(-9, 14), field: "monthly_usd_budget", old_value: 20, new_value: 15 }
      ],
      browser_run: {
        plan: "free",
        today: { minutes_used: 3, minutes_budget: 10, minutes_left: 7 },
        cloudflare_free: { daily_minutes: 10, minutes_used: 3, reset_at: at(1, 5) },
        month: null,
        backup_today: { pages: 1, pages_cap: 5, reasons: ["blocked"] },
        last_runs: [
          { at: at(0, 12), browser_run_pages: 4, browser_run_minutes: 2, backup_pages: 1, failures: 0 },
          { at: at(-1, 12), browser_run_pages: 4, browser_run_minutes: 1, backup_pages: 0, failures: 1 }
        ]
      }
    },
    publicSite: { enabled: true },
    locations: { countries: ["US"], include_remote: true },
    titles: { exclude_words: ["senior", "director", "undergraduate"], titles: [
      { title: "Product Manager Intern", group: "Product", aliases: ["PM Intern", "Product Management Intern"], active: true },
      { title: "Associate Product Manager Intern", group: "Product", aliases: ["APM Intern"], active: true },
      { title: "Technical Product Manager Intern", group: "Product", aliases: ["TPM Intern"], active: true },
      { title: "Strategy Intern", group: "Strategy", aliases: ["Product Strategy Intern"], active: true },
      { title: "Product Marketing Intern", group: "Marketing", aliases: [], active: false }
    ] },
    companies: [
      { id: 1, name: "Northwind Labs", status: "ranked", rank: 1, careers_url: "https://example.com/northwind", feed_type: "Greenhouse" },
      { id: 2, name: "Contoso Cloud", status: "ranked", rank: 2, careers_url: "https://example.com/contoso", feed_type: "Workday" },
      { id: 3, name: "Fabrikam AI", status: "ranked", rank: 3, careers_url: "https://example.com/fabrikam", feed_type: "Lever" },
      { id: 4, name: "Litware Semiconductor", status: "ranked", rank: 4, careers_url: "https://example.com/litware", feed_type: "Workday", last_feed_status: "error", last_feed_error: "careers page blocked" },
      { id: 5, name: "Adatum Payments", status: "pinned", careers_url: "https://example.com/adatum", feed_type: "Greenhouse" },
      { id: 6, name: "Tailspin Games", status: "ranked", rank: 5, careers_url: "https://example.com/tailspin", feed_type: "Ashby" },
      { id: 7, name: "Proseware", status: "ranked", rank: 6, careers_url: "https://example.com/proseware", feed_type: "SmartRecruiters" },
      { id: 8, name: "Wide World Retail", status: "ranked", rank: 7, careers_url: "https://example.com/wideworld", feed_type: null },
      { id: 9, name: "Blue Yonder Airlines", status: "pinned", careers_url: null, last_feed_status: "no_source" },
      { id: 10, name: "Coho Health", status: "ranked", rank: 8, careers_url: "https://example.com/coho", feed_type: "Lever" },
      { id: 11, name: "Margie's Travel", status: "review", careers_url: null, last_feed_status: "no_source" },
      { id: 12, name: "Alpine Ski House", status: "removed", careers_url: null }
    ],
    analytics: null
  };
  data.feedback[0].posting_id = data.earlier[4].id; data.feedback[0].posting_company = data.earlier[4].company_name; data.feedback[0].posting_title = data.earlier[4].title;
  data.feedback[2].posting_id = data.earlier[3].id; data.feedback[2].posting_company = data.earlier[3].company_name; data.feedback[2].posting_title = data.earlier[3].title;

  data.analytics = {
    forecast: { weekly_usd: 2.9, monthly_usd: 11.4 },
    usage_by_step: [
      { step: "discovery", model: "sonnet", tokens: 184200, searches: 9, usd: 3.12 },
      { step: "scout", model: "sonnet", tokens: 61500, searches: 3, usd: 1.05 },
      { step: "classification", model: "haiku", tokens: 92800, searches: 0, usd: 0.21 },
      { step: "improvement", model: "sonnet", tokens: 12400, searches: 0, usd: 0.24 }
    ],
    coverage: data.companies.filter(function (c) { return c.status !== "removed"; }).map(function (c, i) {
      return { name: c.name, posting_count: [3, 2, 2, 1, 2, 1, 1, 1, 0, 1, 0][i] || 0, last_feed_status: c.last_feed_status || "ok" };
    }),
    sources: [
      { name: "Greenhouse job feeds", status: "active", found_count: 14, dead_link_rate: 0.02 },
      { name: "Workday career sites", status: "active", found_count: 9, dead_link_rate: 0.05 },
      { name: "Lever job feeds", status: "active", found_count: 6, dead_link_rate: 0 },
      { name: "Public LinkedIn job pages", status: "active", found_count: 4, dead_link_rate: 0.25 }
    ],
    first_to_find: [{ source_name: "Greenhouse job feeds", n: 8 }, { source_name: "Workday career sites", n: 5 }, { source_name: "Discovery search", n: 2 }],
    postings_per_title: [{ matched_title: "Product Manager Intern", n: 9 }, { matched_title: "Associate Product Manager Intern", n: 2 }, { matched_title: "Strategy Intern", n: 1 }],
    unconfirmed_count: 1,
    verification_methods: [{ verified_via: "feed", n: 8 }, { verified_via: "structured", n: 2 }, { verified_via: "browser", n: 1 }, { verified_via: "mirror", n: 1 }, { verified_via: null, n: 1 }],
    pruned: [{ archive_reason: "Closed for 14 days", n: 3 }, { archive_reason: "Deleted by you", n: 1 }],
    alerts: [{ type: "careers_page", severity: "warning", message: "Litware Semiconductor careers page shows a bot check", created_at: at(-1, 12) }],
    postings_per_source: { feed: 9, careers_page: 2, discovery: 1, email: 1 },
    careers_pages_per_run: [
      { run_id: 42, at: at(0, 12), method: "browser_run", pages: 4, changed: 1, unchanged: 2, failures: 1 },
      { run_id: 42, at: at(0, 12), method: "backup", pages: 1, failures: 0 },
      { run_id: 41, at: at(-1, 12), method: "browser_run", pages: 4, changed: 0, unchanged: 4, failures: 0 }
    ],
    discovery_searches_per_run: [{ started_at: at(0, 12), searches: 2 }, { started_at: at(-1, 12), searches: 3 }],
    recent_runs: [
      { started_at: at(0, 12), finished_at: at(0, 12).replace("T12:00", "T12:09"), status: "completed", new_count: 5, source: "cloudflare" },
      { started_at: at(-1, 12), finished_at: at(-1, 12).replace("T12:00", "T12:11"), status: "completed", new_count: 2, source: "cloudflare" },
      { started_at: at(-2, 12), finished_at: at(-2, 12).replace("T12:00", "T12:07"), status: "completed", new_count: 1, source: "schedule" }
    ]
  };

  var OFF = "Searching is turned off in this demo. In the real dashboard it runs a Claude search.";

  function json(body, status) {
    var code = status || 200;
    return Promise.resolve(new Response(code === 204 ? null : JSON.stringify(body), {
      status: code, headers: { "Content-Type": "application/json" }
    }));
  }
  function allPostings() { return data.today.concat(data.earlier, data.archived); }
  function findPosting(id) { return allPostings().filter(function (p) { return p.id === id; })[0]; }
  function moveTo(p, tab) {
    ["today", "earlier", "archived"].forEach(function (t) { data[t] = data[t].filter(function (x) { return x !== p; }); });
    data[tab].unshift(p);
  }

  function route(method, path, body) {
    var q = path.split("?")[1] || ""; path = path.split("?")[0];
    var m;
    if (method === "GET") {
      if (path === "/postings") { var tab = /tab=(\w+)/.exec(q); return json({ postings: data[tab ? tab[1] : "today"] }); }
      if (path === "/sources") return json({ sources: data.sources, careers_pages: data.careersPages });
      if (path === "/feedback") return json({ feedback: data.feedback });
      if (path === "/proposals") return json({ proposals: data.proposals });
      if (path === "/analytics") return json(data.analytics);
      if (path === "/budgets") return json(data.budgets);
      if (path === "/settings/public-site") return json(data.publicSite);
      if (path === "/settings/locations") return json(data.locations);
      if (path === "/titles") return json(data.titles);
      if (path === "/titles/pending") return json({ pending: null });
      if (path === "/companies") return json({ companies: data.companies });
      if (path === "/search/status") return json({ busy: false });
      if (/^\/(search\/runs|companies\/check)\//.test(path)) return json({ status: "failed", result: { error: OFF } });
    }
    if (method === "POST") {
      if (path === "/search/runs" || path === "/companies/check") return json({ detail: OFF }, 403);
      if ((m = /^\/postings\/(\d+)\/(applied|public-hidden|confirm|restore)$/.exec(path))) {
        var p = findPosting(+m[1]); if (!p) return json({ detail: "not found" }, 404);
        if (m[2] === "applied") p.applied = body.applied ? 1 : 0;
        if (m[2] === "public-hidden") p.public_hidden = body.hidden ? 1 : 0;
        if (m[2] === "confirm") { p.user_status = body.status; p.status = body.status === "closed" ? "closed" : "open"; p.verified_via = "user"; p.status_note = null; }
        if (m[2] === "restore") moveTo(p, "earlier");
        return json(p);
      }
      if ((m = /^\/feedback\/(\d+)\/(status|issue)$/.exec(path))) {
        var f = data.feedback.filter(function (x) { return x.id === +m[1]; })[0];
        if (f) f.status = m[2] === "status" ? body.status : "read";
        return json(f || {});
      }
      if ((m = /^\/proposals\/(\d+)\/(approve|reject)$/.exec(path))) {
        data.proposals = data.proposals.filter(function (x) { return x.id !== +m[1]; });
        return json({});
      }
      if (path === "/sources") {
        data.sources.push({ id: nextId++, name: body.name, url: body.url, kind: "Added by you", found_count: 0, covers: "", last_checked: null, notes: "" });
        return json({});
      }
      if (path === "/budgets/resets") return json(data.budgets);
      if (path === "/companies") {
        data.companies.push({ id: nextId++, name: body.name, status: "pinned", careers_url: body.careers_url, feed_type: null, last_feed_status: body.careers_url ? null : "no_source" });
        return json({});
      }
      if ((m = /^\/companies\/(\d+)\/(pin|unpin)$/.exec(path))) {
        var c = data.companies.filter(function (x) { return x.id === +m[1]; })[0];
        if (c) c.status = m[2] === "pin" ? "pinned" : "removed";
        return json({});
      }
      if (path === "/companies/paste/preview") {
        var known = data.companies.map(function (x) { return x.name.toLowerCase(); });
        return json({ entries: String(body.text || "").split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (name) {
          return { raw: name, name: name, url: null, match: known.indexOf(name.toLowerCase()) >= 0 ? "existing" : "new" };
        }) });
      }
      if (path === "/companies/paste/save") {
        (body.entries || []).forEach(function (e) { data.companies.push({ id: nextId++, name: e.name, status: "pinned", careers_url: e.url, last_feed_status: "no_source" }); });
        return json({ saved: body.entries || [] });
      }
    }
    if (method === "PUT") {
      if (path === "/budgets") { Object.assign(data.budgets.settings, (body.doc && body.doc.settings) || body.doc || {}); return json(data.budgets); }
      if (path === "/settings/public-site") { data.publicSite = body; return json(body); }
      if (path === "/settings/locations") { data.locations = body; return json({}); }
      if (path === "/titles") { data.titles = body.doc || data.titles; return json({ pending: null }); }
    }
    if (method === "DELETE") {
      if ((m = /^\/postings\/(\d+)$/.exec(path))) { var d = findPosting(+m[1]); if (d) { d.archive_reason = "Deleted by you"; moveTo(d, "archived"); } return json(null, 204); }
      if ((m = /^\/sources\/(\d+)$/.exec(path))) { data.sources = data.sources.filter(function (s) { return s.id !== +m[1]; }); return json(null, 204); }
    }
    return json({ detail: "Not available in the demo." }, 404);
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    if (/^\/api\//.test(url)) {
      var method = ((init && init.method) || "GET").toUpperCase();
      var body = {};
      try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { body = {}; }
      return new Promise(function (r) { setTimeout(r, 120); }).then(function () { return route(method, url.slice(4), body); });
    }
    return realFetch(input, init);
  };

  // The artifact frame refuses window.confirm; the demo has nothing to lose, so it always agrees.
  window.confirm = function () { return true; };

  // Search costs real credits, so both search buttons are switched off and say why.
  function disableSearch() {
    var b = document.getElementById("searchNowBtn");
    if (b && !b.dataset.demoOff) {
      b.dataset.demoOff = "1"; b.disabled = true; b.title = OFF;
      var l = document.getElementById("searchNowLabel"); if (l) l.textContent = "Search now (off in demo)";
    }
    Array.prototype.forEach.call(document.querySelectorAll("button"), function (x) {
      if (x.textContent === "Check now" && !x.disabled) { x.disabled = true; x.title = OFF; }
    });
  }
  document.addEventListener("DOMContentLoaded", function () {
    disableSearch();
    new MutationObserver(disableSearch).observe(document.body, { childList: true, subtree: true });
    var bar = document.createElement("div");
    bar.className = "demo-bar";
    bar.innerHTML = "<b>DEMO</b> Internship Watch with sample data. Nothing is saved and searching is off.";
    document.body.insertBefore(bar, document.body.firstChild);
  });
})();
