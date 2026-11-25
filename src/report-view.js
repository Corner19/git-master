/**
 * The daily report surface (日报).
 *
 * A report is per project, not per repository: it covers every repository the
 * workspace holds and lists each one with its own address, so a project that
 * points at several remotes still reads as one day of work. The engine does the
 * collecting (`lib/daily-report.js`); this file renders what it returns and
 * forwards the few actions a person needs — generate, copy, delete, configure.
 *
 * History is a list on the left and one report on the right, the same shape as
 * the Log pane beside it: "what did I do on the 3rd?" is answered by picking a
 * row, not by a dialog that covers the list it came from.
 */
(function (PIG) {
  "use strict";

  const { h, t, tf, invoke, toast, clear, iconButton, textButton, dialog, runWithPill, errorText } = PIG;

  /** Engine codes that deserve wording of their own. */
  const FRIENDLY = {
    REPORT_TOO_LARGE: () => t("reportTooLarge"),
    NO_MODEL: () => t("reportNoModel"),
    PERMISSION_DENIED: () => t("modelPermission"),
    NO_REPOSITORY: () => t("notARepository"),
  };

  function failureText(result) {
    const friendly = FRIENDLY[result?.code];
    return friendly ? friendly() : errorText(result);
  }

  function formatWindow(interval) {
    if (!interval?.from || !interval?.to) return "";
    return `${PIG.formatDateTime(interval.from)} → ${PIG.formatDateTime(interval.to)}`;
  }

  /**
   * The stored model keeps a delivery slot even though nothing is delivered
   * today; `stored` is the only state it can hold now, and an unknown one is
   * shown verbatim rather than invented into a friendlier word.
   */
  function stateLabel(delivery) {
    const status = String(delivery?.status ?? "stored");
    return status === "stored" ? t("reportStatusStored") : status;
  }

  function mount(root) {
    const state = {
      config: null,
      repositories: [],
      detectedAuthors: [],
      models: [],
      reports: [],
      report: null,
      settings: false,
      loading: false,
    };

    const listHost = h("div", { class: "scroll grow report-list" });
    const detailHost = h("div", { class: "scroll grow report-detail" });
    const toolbar = h("div", { class: "toolbar" });
    const generateButton = textButton(t("reportGenerate"), t("reportGenerate"), () => generate().catch(() => {}), { class: "primary" });
    const copyButton = iconButton("copy", t("reportCopy"), () => copy().catch(() => {}), { disabled: true });
    const settingsButton = iconButton("gear", t("reportSettings"), () => {
      state.settings = !state.settings;
      paint();
    });
    const refreshButton = iconButton("refresh", t("refresh"), () => load().catch(() => {}), {});

    toolbar.append(generateButton, copyButton, h("div", { class: "toolbar-spacer" }), settingsButton, refreshButton);
    root.append(
      toolbar,
      h("div", { class: "row grow" }, [
        h("div", { class: "column report-side" }, [
          h("div", { class: "pane-header" }, [h("span", { text: t("reportHistory") })]),
          listHost,
        ]),
        h("div", { class: "divider-v" }),
        h("div", { class: "column grow" }, [detailHost]),
      ]),
    );

    // ------------------------------------------------------------- loading ---

    async function load() {
      if (state.loading) return;
      state.loading = true;
      try {
        const config = await invoke("git/report-config");
        if (!config?.ok) {
          clear(listHost).append(h("div", { class: "empty-state" }, [
            h("div", { class: "headline", text: failureText(config) }),
          ]));
          return;
        }
        state.config = config.config;
        state.repositories = config.repositories ?? [];
        state.detectedAuthors = config.detectedAuthors ?? [];
        state.models = config.models ?? [];

        const listed = await invoke("git/report-list");
        state.reports = listed?.ok ? listed.reports ?? [] : [];
        // Keep the selection honest: a deleted date, or a first run, shows the
        // newest report instead of a stale one.
        const known = state.reports.some((entry) => entry.reportDate === state.report?.reportDate);
        if (!known) {
          state.report = state.reports.length ? await getReport(state.reports[0].reportDate) : null;
        }
        paint();
      } finally {
        state.loading = false;
      }
    }

    async function getReport(date) {
      const result = await invoke("git/report-get", { date });
      return result?.ok ? result.report : null;
    }

    // ------------------------------------------------------------ painting ---

    function paint() {
      paintList();
      paintDetail();
      copyButton.disabled = !state.report?.summary;
      settingsButton.classList.toggle("active", state.settings);
    }

    function paintList() {
      clear(listHost);
      if (!state.reports.length) {
        listHost.append(h("div", { class: "empty-state" }, [
          h("div", { class: "headline", text: t("reportEmptyHistory") }),
        ]));
        return;
      }
      for (const entry of state.reports) {
        listHost.append(h("div", {
          class: "tree-row report-row",
          tabindex: "0",
          "aria-selected": state.report?.reportDate === entry.reportDate ? "true" : "false",
          title: entry.summary,
          onclick: () => select(entry.reportDate).catch(() => {}),
          onkeydown: (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            select(entry.reportDate).catch(() => {});
          },
        }, [
          h("span", { class: "name mono", text: entry.reportDate }),
          h("span", { class: "muted report-count", text: tf("reportCommits", { count: entry.commits }) }),
          entry.trigger === "scheduled" ? h("span", { class: "badge local", text: t("reportTriggerScheduled") }) : null,
        ]));
      }
    }

    async function select(date) {
      state.settings = false;
      state.report = await getReport(date);
      paint();
    }

    function paintDetail() {
      clear(detailHost);
      if (state.settings) return paintSettings();

      const report = state.report;
      if (!report) {
        detailHost.append(h("div", { class: "empty-state" }, [
          h("div", { class: "headline", text: t("reportDetail") }),
          h("div", { class: "muted", text: t("reportEmptyHistory") }),
        ]));
        return;
      }

      detailHost.append(h("div", { class: "report-head" }, [
        h("div", { class: "report-title" }, [
          h("strong", { text: report.reportDate }),
          h("span", { class: "badge", title: t("reportStatus"), text: stateLabel(report.delivery) }),
          report.trigger === "scheduled" ? h("span", { class: "badge local", text: t("reportTriggerScheduled") }) : null,
        ]),
        h("div", { class: "muted", text: `${t("reportWindow")}: ${formatWindow(report.interval)}` }),
        h("div", { class: "muted", text: [
          tf("reportCommits", { count: report.commits?.length ?? 0 }),
          tf("reportRepositories", { count: report.repositories?.length ?? 0 }),
          report.stats?.duplicates ? tf("reportShared", { count: report.stats.duplicates }) : null,
          `${t("reportGeneratedAt")} ${PIG.formatDateTime(Date.parse(report.generatedAt))}`,
          `${t("reportModelUsed")} ${report.modelKey ?? ""}`.trim(),
        ].filter(Boolean).join(" · ") }),
      ]));

      for (const warning of report.warnings ?? []) {
        detailHost.append(h("div", { class: "report-warning", text: warning }));
      }

      detailHost.append(report.summary
        ? h("pre", { class: "report-summary", text: report.summary })
        : h("div", { class: "muted report-empty", text: t("reportEmpty") }));

      // Each commit keeps the repository it came from and every repository that
      // carries it: that is the "one project, several addresses" case, shown
      // rather than collapsed into a number.
      if (report.commits?.length) {
        const host = h("div", { class: "report-commits" });
        host.append(h("div", { class: "pane-header", text: t("reportDetail") }));
        for (const commit of report.commits) {
          host.append(h("div", { class: "report-commit" }, [
            h("span", { class: "mono report-hash", text: commit.short ?? "" }),
            h("span", { class: "report-subject", text: commit.subject ?? "" }),
            h("span", { class: "muted report-repos", title: commit.hash, text: tf("reportInRepositories", { repos: (commit.repos ?? []).join(", ") }) }),
          ]));
        }
        detailHost.append(host);
      }

      if (report.repositories?.length) {
        const host = h("div", { class: "report-repos-list" });
        host.append(h("div", { class: "pane-header", text: t("reportRepositoriesTitle") }));
        for (const repository of report.repositories) {
          host.append(h("div", { class: "report-repo" }, [
            h("span", { class: "name", text: repository.rel }),
            h("span", {
              class: "muted mono report-remote",
              title: repository.remote || t("reportNoRemote"),
              text: repository.remote || t("reportNoRemote"),
            }),
            h("span", { class: "muted report-count", text: tf("reportCommits", { count: repository.commitCount ?? 0 }) }),
          ]));
        }
        detailHost.append(host);
      }

      detailHost.append(h("div", { class: "report-actions" }, [
        textButton(t("reportDelete"), t("reportDelete"), () => remove(report.reportDate).catch(() => {}), { class: "bordered" }),
        textButton(t("reportRegenerate"), t("reportRegenerate"), () => generate(report.reportDate).catch(() => {}), { class: "bordered" }),
      ]));
    }

    // ------------------------------------------------------------ settings ---

    function paintSettings() {
      const config = state.config ?? {};
      const excluded = new Set(config.excludeRepos ?? []);

      const enabled = h("input", { type: "checkbox" });
      enabled.checked = config.enabled === true;
      const schedule = h("input", { type: "text", value: config.schedule ?? "17:20", size: "6", placeholder: "17:20" });

      const model = h("select", null);
      if (!state.models.length) {
        model.append(h("option", { value: "", text: t("reportNoModel") }));
      } else {
        for (const entry of state.models) {
          const option = h("option", { value: entry.key, text: entry.label ?? entry.key });
          if (entry.key === config.modelKey) option.selected = true;
          model.append(option);
        }
        if (!config.modelKey) model.selectedIndex = 0;
      }

      const authors = h("textarea", { rows: "3", spellcheck: "false" });
      authors.value = (config.authorEmails ?? []).join("\n");
      authors.placeholder = state.detectedAuthors.join("\n") || t("reportAuthorsHint");

      const reposHost = h("div", { class: "report-repo-picker" });
      if (!state.repositories.length) {
        reposHost.append(h("div", { class: "muted", text: t("notARepository") }));
      }
      for (const repository of state.repositories) {
        const box = h("input", { type: "checkbox" });
        box.checked = !excluded.has(repository.rel);
        box.dataset.rel = repository.rel;
        reposHost.append(h("label", { class: "report-repo-option", title: repository.remote || t("reportNoRemote") }, [
          box,
          h("span", { class: "name", text: repository.rel }),
          h("span", { class: "muted mono report-remote", text: repository.remote || t("reportNoRemote") }),
        ]));
      }

      detailHost.append(h("div", { class: "report-settings" }, [
        h("div", { class: "pane-header", text: t("reportSettings") }),
        h("label", { class: "report-field" }, [enabled, h("span", { text: t("reportEnabled") })]),
        h("label", { class: "report-field" }, [h("span", { text: t("reportSchedule") }), schedule]),
        h("label", { class: "report-field" }, [h("span", { text: t("reportModel") }), model]),
        h("label", { class: "report-field column" }, [
          h("span", { text: t("reportAuthors") }),
          authors,
          h("span", { class: "muted report-hint", text: t("reportAuthorsHint") }),
        ]),
        h("div", { class: "report-field column" }, [
          h("span", { text: t("reportRepositoriesTitle") }),
          h("span", { class: "muted report-hint", text: t("reportRepositoriesHint") }),
          reposHost,
        ]),
        h("div", { class: "report-actions" }, [
          textButton(t("reportSave"), t("reportSave"), () => save({ enabled, schedule, model, authors, reposHost }).catch(() => {}), { class: "primary" }),
        ]),
      ]));
    }

    // ------------------------------------------------------------- actions ---

    async function save(form) {
      const included = new Set([...form.reposHost.querySelectorAll("input:checked")].map((box) => box.dataset.rel));
      const result = await invoke("git/report-config-save", {
        config: {
          enabled: form.enabled.checked,
          schedule: form.schedule.value,
          modelKey: form.model.value,
          authorEmails: form.authors.value.split(/[\n,]/),
          // The form lists what is *included*; the engine stores what is
          // excluded, so this is the one place the two vocabularies meet.
          excludeRepos: state.repositories.map((repository) => repository.rel).filter((rel) => !included.has(rel)),
        },
      });
      if (!result?.ok) {
        toast(failureText(result), "error");
        return;
      }
      state.config = result.config;
      toast(t("reportSaved"), "info");
      await load();
    }

    async function generate(date) {
      const result = await runWithPill(t("reportGenerate"), () => invoke("git/report-generate", date ? { date } : {}));
      if (!result?.ok) {
        toast(failureText(result), "error");
        return;
      }
      if (result.empty) {
        // No commits is an answer, not a failure: the engine refuses to ask the
        // model for a summary of nothing, and the panel says so plainly.
        toast(t("reportEmpty"), "info");
        await load();
        return;
      }
      // Show the fresh report immediately; `load()` then reconciles the list and
      // keeps this selection, because its date is now in the history.
      state.report = result.report;
      state.settings = false;
      await load();
    }

    async function copy() {
      if (!state.report?.summary) return;
      await PIG.copyText(state.report.summary);
      toast(t("reportCopied"), "info");
    }

    async function remove(date) {
      const confirmed = await dialog({
        title: t("reportDelete"),
        message: tf("reportDeleteConfirm", { date }),
        confirmLabel: t("reportDelete"),
        danger: true,
      });
      if (!confirmed) return;
      const result = await invoke("git/report-delete", { date });
      if (!result?.removed) {
        toast(errorText(result), "error");
        return;
      }
      toast(t("reportDeleted"), "info");
      if (state.report?.reportDate === date) state.report = null;
      await load();
    }

    // Not loaded eagerly: the surface is only visible once its tab is picked, and
    // `applyMode` calls `refresh()` at that moment. A directory walk plus three
    // `git` reads per repository on every panel open — for a tab the user may
    // never look at — is work nobody asked for.
    paint();

    return {
      refresh: () => load().catch(() => {}),
      showSettings: () => {
        state.settings = true;
        paint();
      },
    };
  }

  PIG.reportView = { mount };
})(window.PIG || (window.PIG = {}));
