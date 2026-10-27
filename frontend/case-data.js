(() => {
  const params = new URLSearchParams(window.location.search);
  const requestedCase = params.get("case");
  const caseUrl = requestedCase
    ? "/api/cases/" + encodeURIComponent(requestedCase)
    : new URL("demo-case.json", window.location.href);

  window.WakeTraceCase = {
    load: () => {
      return fetch(caseUrl).then((response) => {
      if (!response.ok) throw new Error("Could not load case data (" + response.status + ")");
      return response.json();
      });
    },
    formatUtc(value) {
      if (!value) return "Not available";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "Not available";
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(date) + " UTC";
    },
    markCaseLinks(caseData) {
      document.querySelectorAll("[data-case-link]").forEach((link) => {
        const url = new URL(link.href, window.location.href);
        if (requestedCase) url.searchParams.set("case", caseData.case_id || requestedCase);
        if (params.get("demo") === "1") url.searchParams.set("demo", "1");
        link.href = url.pathname.split("/").pop() + url.search + url.hash;
      });
    },
    markSynthetic(caseData) {
      const synthetic = caseData.synthetic === true || caseData.is_synthetic_demo === true;
      const badge = document.getElementById("case-badge");
      if (badge) {
        badge.textContent = synthetic ? "SYNTHETIC EXAMPLE" : "CASE DATA";
        badge.classList.toggle("real-case-badge", !synthetic);
      }
      const notice = document.getElementById("case-notice");
      if (notice) {
        notice.textContent = synthetic
          ? "Synthetic example only. Geometry, timing, and environmental forcing are placeholders, not observations from a real spill."
          : "Review source provenance and uncertainty before interpreting this case.";
        notice.hidden = false;
      }
      document.title = "WakeTrace | " + (caseData.title || caseData.case_id || "Case review");
      this.markCaseLinks(caseData);
      return synthetic;
    },
  };
})();
