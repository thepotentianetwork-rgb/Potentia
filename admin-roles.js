/* Role-portal helpers for the admin CRM pages: the "Assign builder" control on
   a won order. Works for the owner and for a sales login (same token key). */
(function (g) {
  'use strict';
  var API = "https://potentia-assistant.thepotentianetwork.workers.dev";
  function hdr() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (localStorage.getItem('potentia_admin_token') || '') }; }
  var buildersP = null;
  function builders() {
    if (!buildersP) buildersP = fetch(API + '/portal/builders', { headers: hdr() }).then(function (r) { return r.json(); }).then(function (d) { return d.builders || []; }).catch(function () { return []; });
    return buildersP;
  }
  function assignControl(subId) {
    var wrap = document.createElement('label');
    wrap.className = 'assign-builder';
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--silver)";
    wrap.appendChild(document.createTextNode('Builder'));
    var sel = document.createElement('select');
    sel.style.cssText = "background:rgba(255,255,255,0.03);border:1px solid var(--dim);color:var(--bright);font-family:'DM Mono',monospace;font-size:11px;padding:6px 8px";
    sel.innerHTML = '<option value="">— unassigned —</option>';
    wrap.appendChild(sel);
    Promise.all([builders(), fetch(API + '/portal/jobs/' + subId + '/assign', { headers: hdr() }).then(function (r) { return r.json(); }).catch(function () { return {}; })])
      .then(function (res) {
        res[0].forEach(function (b) { var o = document.createElement('option'); o.value = b.id; o.textContent = b.name || b.login; sel.appendChild(o); });
        if (res[1] && res[1].assignment) sel.value = String(res[1].assignment.builder_id);
      });
    sel.addEventListener('change', function () {
      sel.disabled = true;
      fetch(API + '/portal/jobs/' + subId + '/assign', { method: 'POST', headers: hdr(), body: JSON.stringify({ builder_id: sel.value ? Number(sel.value) : null }) })
        .then(function (r) { if (!r.ok) alert('Could not assign builder'); })
        .finally(function () { sel.disabled = false; });
    });
    return wrap;
  }
  g.AdminRoles = { assignControl: assignControl };
})(window);
