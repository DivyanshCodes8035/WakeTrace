(() => {
  const params = new URLSearchParams(window.location.search);
  const requestedCase = params.get("case");
  const caseUrl = requestedCase
    ? "/api/cases/" + encodeURIComponent(requestedCase)
    : new URL("demo-case.json", window.location.href);

  window.WakeTraceCase = {
    load: () => {
      if (params.get("demo") === "1") {
        try {
          const practiceCase = JSON.parse(sessionStorage.getItem("waketrace.practice-result.v1") || "null");
          if (practiceCase && practiceCase.practice_result === true) return Promise.resolve(practiceCase);
        } catch (error) {
          console.warn("Could not restore the current practice result", error);
        }
      }
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
<<<<<<< HEAD
        link.href = url.pathname.split("/").pop() + url.search + url.hash;
=======
        link.href = url.pathname.split("/").pop() + url.search;
>>>>>>> 8a836183111d7c65ef38378c8e347370d64b4fbe
      });
    },
    markSynthetic(caseData) {
      const synthetic = caseData.synthetic === true || caseData.is_synthetic_demo === true;
      const badge = document.getElementById("case-badge");
      if (badge) {
        badge.textContent = caseData.practice_result ? "SYNTHETIC PRACTICE" : synthetic ? "SYNTHETIC EXAMPLE" : "CASE DATA";
        badge.classList.toggle("real-case-badge", !synthetic);
      }
      const notice = document.getElementById("case-notice");
      if (notice) {
        notice.textContent = caseData.practice_result
          ? caseData.synthetic_notice
          : synthetic
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
