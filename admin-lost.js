/* "Why was it lost?" prompt for ShedPro CRM. window.askLostReason(current, cb)
   cb({lost_reason, lost_competitor, lost_note}) or cb(null) if skipped/cancelled. */
(function () {
  var REASONS = [['money', 'Money / Price'], ['competitor', 'Competitor'], ['timing', 'Timing'], ['scope', 'Scope of work'], ['other', 'Other']];
  window.LOST_REASON_LABELS = { money: 'Money / Price', competitor: 'Competitor', timing: 'Timing', scope: 'Scope of work', other: 'Other' };
  function el(t, css, txt) { var e = document.createElement(t); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; }
  window.askLostReason = function (cur, cb) {
    cur = cur || {};
    var ov = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;font-family:inherit');
    var box = el('div', 'background:var(--panel,#1b1f24);color:var(--text,#eee);border:1px solid var(--line,#333);border-radius:10px;padding:22px 24px;width:min(420px,92vw);box-shadow:0 10px 40px rgba(0,0,0,.5)');
    box.appendChild(el('h3', 'margin:0 0 4px;font-size:18px', 'Why was it lost?'));
    box.appendChild(el('div', 'font-size:12px;opacity:.7;margin-bottom:14px', 'Helps track why deals slip away.'));
    var picked = cur.lost_reason || null, btns = {};
    var grid = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px');
    REASONS.forEach(function (r) {
      var b = el('button', 'padding:10px;border-radius:7px;border:1px solid var(--line,#444);background:transparent;color:inherit;cursor:pointer;font-size:14px;text-align:left', r[1]);
      b.type = 'button'; btns[r[0]] = b;
      b.onclick = function () { picked = r[0]; paint(); };
      grid.appendChild(b);
    });
    box.appendChild(grid);
    var comp = el('input', 'width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border-radius:6px;border:1px solid var(--line,#444);background:transparent;color:inherit;display:none');
    comp.placeholder = 'Competitor name (optional)'; comp.value = cur.lost_competitor || '';
    var note = el('textarea', 'width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid var(--line,#444);background:transparent;color:inherit;min-height:60px');
    note.placeholder = 'Note (optional)'; note.value = cur.lost_note || '';
    box.appendChild(comp); box.appendChild(note);
    var row = el('div', 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px');
    var skip = el('button', 'padding:8px 14px;border-radius:6px;border:1px solid var(--line,#444);background:transparent;color:inherit;cursor:pointer', 'Skip'); skip.type = 'button';
    var save = el('button', 'padding:8px 16px;border-radius:6px;border:0;background:var(--accent,#c8a24a);color:#111;font-weight:600;cursor:pointer', 'Save reason'); save.type = 'button';
    row.appendChild(skip); row.appendChild(save); box.appendChild(row);
    function paint() {
      Object.keys(btns).forEach(function (k) { btns[k].style.background = k === picked ? 'var(--accent,#c8a24a)' : 'transparent'; btns[k].style.color = k === picked ? '#111' : 'inherit'; });
      comp.style.display = picked === 'competitor' ? 'block' : 'none'; save.disabled = !picked; save.style.opacity = picked ? '1' : '.5';
    }
    paint();
    function close(v) { document.body.removeChild(ov); cb(v); }
    skip.onclick = function () { close(null); };
    save.onclick = function () { if (picked) close({ lost_reason: picked, lost_competitor: picked === 'competitor' ? comp.value.trim() : '', lost_note: note.value.trim() }); };
    ov.appendChild(box); document.body.appendChild(ov);
  };
  window.lostReasonText = function (s) {
    if (!s || !s.lost_reason) return 'Reason not recorded';
    return (LOST_REASON_LABELS[s.lost_reason] || s.lost_reason) + (s.lost_competitor ? ' — ' + s.lost_competitor : '') + (s.lost_note ? ' · ' + s.lost_note : '');
  };
})();
