/**
 * dsh-git-plugin — Client half：在「设置 → 插件 → dsh-git-plugin」的页面里渲染一张配置卡片
 * （git 安装根目录 / git 可执行文件 / 默认仓库 / 受保护分支）。
 *
 * 为什么必须有它：DSH **不会**为第三方 bundle 自动生成配置表单。官方 cookbook
 * （实践指南：即时配置表单）说明表单要"通过产品所属的设置卡片提供编辑入口"，
 * 承载槽位是 `plugins.bundle.config`（key = 包名，渲染在 bundle 页面的描述与行之间）。
 *
 * 读写走插件自己的宿主路由 `/git-plugin/api/config`（宿主用官方 `settings.update()`
 * 写进 profile 覆盖层），两端契约可核实；宿主写完 volatile 值即时更新，
 * 所以**保存后立刻生效、无需重启**。
 */
window.__ModuleLoader__.load({
  id: "dsh-git-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useCallback, useEffect, useState } = React;
    const h = React.createElement;

    const API = "/git-plugin/api/config";
    const CSS_ID = "dsh-git-plugin-settings";
    const CSS = [
      ".dgp-card{display:flex;flex-direction:column;gap:10px;padding:10px 0 4px}",
      ".dgp-row{display:flex;flex-direction:column;gap:4px}",
      ".dgp-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
      ".dgp-input{height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-secondary,#d0d5dd);",
      "border-radius:6px;background:var(--dsw-alias-bg-elevated,transparent);color:inherit;",
      "font-family:inherit;font-size:12px;width:100%;box-sizing:border-box}",
      ".dgp-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit);word-break:break-all}",
      ".dgp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dgp-btn{height:26px;padding:0 10px;border:0;border-radius:6px;cursor:pointer;font-family:inherit;",
      "font-size:12px;background:var(--dsw-alias-bg-accent,#3b82f6);color:#fff}",
      ".dgp-btn[disabled]{opacity:.5;cursor:default}",
      ".dgp-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary,inherit);",
      "border:1px solid var(--dsw-alias-border-secondary,#d0d5dd)}",
      ".dgp-status{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}",
      ".dgp-status[data-tone=error]{color:#dc2626}",
    ].join("");

    function ensureCss() {
      if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
      const style = document.createElement("style");
      style.id = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /** 四个字段都是"换机器要改"的东西；受保护分支在界面上用逗号分隔。 */
    const FIELDS = [
      { key: "gitDir", label: "Git 安装根目录", placeholder: "如 C:\\Program Files\\Git、/usr/local；留空 = 自动探测" },
      { key: "gitPath", label: "git 可执行文件完整路径", placeholder: "优先于上一项；留空 = 自动探测" },
      { key: "defaultRepo", label: "默认仓库目录", placeholder: "调用没传 repo 时用它；留空 = 进程 cwd" },
      { key: "protectedBranches", label: "受保护分支（逗号分隔）", placeholder: "main, master —— 拒绝对它们强制推送" },
    ];

    const emptyValues = () => ({ gitDir: "", gitPath: "", defaultRepo: "", protectedBranches: "" });

    /** 宿主返回的 protectedBranches 是数组，输入框里要逗号串。 */
    function toInputs(raw) {
      const branches = raw?.protectedBranches;
      return {
        gitDir: raw?.gitDir ?? "",
        gitPath: raw?.gitPath ?? "",
        defaultRepo: raw?.defaultRepo ?? "",
        protectedBranches: Array.isArray(branches) ? branches.join(", ") : typeof branches === "string" ? branches : "",
      };
    }

    function GitPluginSettingsCard() {
      const [values, setValues] = useState(null);
      const [effective, setEffective] = useState(null);
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState("加载中…");
      const [tone, setTone] = useState("info");

      const applyResult = useCallback((result) => {
        setValues(toInputs(result?.values));
        setEffective(result?.effective ?? null);
      }, []);

      useEffect(() => {
        ensureCss();
        let alive = true;
        fetch(API, { headers: { accept: "application/json" } })
          .then((response) => response.json())
          .then((body) => {
            if (!alive) return;
            if (body && body.ok) {
              applyResult(body.result);
              setTone("info");
              setStatus("");
            } else {
              setTone("error");
              setStatus((body && body.error) || "读取失败");
            }
          })
          .catch((error) => {
            if (!alive) return;
            setTone("error");
            setStatus("读取失败：" + ((error && error.message) || String(error)));
          });
        return () => {
          alive = false;
        };
      }, [applyResult]);

      const onChange = useCallback(
        (key) => (event) => {
          const next = event.target.value;
          setValues((prev) => ({ ...(prev ?? emptyValues()), [key]: next }));
        },
        [],
      );

      const save = useCallback(() => {
        setBusy(true);
        setTone("info");
        setStatus("保存中…");
        fetch(API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values ?? emptyValues()),
        })
          .then((response) => response.json())
          .then((body) => {
            if (body && body.ok) {
              applyResult(body.result);
              setTone("info");
              setStatus("已保存" + (body.result && body.result.writtenTo ? "（写入 " + body.result.writtenTo + "）" : "") + "，立即生效");
            } else {
              setTone("error");
              setStatus((body && body.error) || "保存失败");
            }
          })
          .catch((error) => {
            setTone("error");
            setStatus("保存失败：" + ((error && error.message) || String(error)));
          })
          .finally(() => setBusy(false));
      }, [values, applyResult]);

      if (values === null) {
        return h("div", { className: "dgp-card" }, h("div", { className: "dgp-status", "data-tone": tone }, status));
      }

      return h(
        "div",
        { className: "dgp-card" },
        FIELDS.map((field) =>
          h(
            "label",
            { className: "dgp-row", key: field.key },
            h("span", { className: "dgp-label" }, field.label),
            h("input", {
              className: "dgp-input",
              value: values[field.key] ?? "",
              placeholder: field.placeholder,
              spellCheck: false,
              disabled: busy,
              onChange: onChange(field.key),
            }),
          ),
        ),
        h(
          "div",
          { className: "dgp-actions" },
          h("button", { className: "dgp-btn", type: "button", disabled: busy, onClick: save }, busy ? "保存中…" : "保存"),
          h(
            "button",
            {
              className: "dgp-btn dgp-btn-ghost",
              type: "button",
              disabled: busy,
              onClick: () => {
                setValues(emptyValues());
                setTone("info");
                setStatus("已清空，点保存后恢复自动探测");
              },
            },
            "清空（改用自动探测）",
          ),
          h("span", { className: "dgp-status", "data-tone": tone }, status),
        ),
        effective
          ? h(
              "div",
              { className: "dgp-hint" },
              "当前生效的 git：",
              effective.gitPath || "(未探测到)",
              h("br"),
              "来源：",
              effective.gitSource || "(未知)",
              effective.gitResolved === false ? "（未在标准位置找到，交给 PATH）" : "",
              h("br"),
              "默认仓库：",
              effective.defaultRepo || "(未设置，用进程 cwd)",
              "　受保护分支：",
              (effective.protectedBranches ?? []).join("、") || "(无)",
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            id: "dsh-git-plugin-bundle-config",
            key: "dsh-git-plugin",
          },
          (ownerProps = {}) => (ownerProps && ownerProps.view === "summary" ? null : h(GitPluginSettingsCard, null)),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.GitPluginSettingsCard = GitPluginSettingsCard;
    return module.exports;
  },
});
