/* Locate sign-in, shared by the app (index.html) and the phone tracker (tracker.html).

   Two roles: "customer" (vehicle owner) and "admin" (control room).

   IMPORTANT: there is no server, so the check runs in the browser. It keeps the
   views apart for a demo; it is NOT real security. Anyone who can read this file
   or the broker topic can get past it. A real product needs accounts on a server
   and broker-side access control.

   Both pages use the same element ids for the sign-in form:
   login, loginForm, roleCustomer, roleAdmin, loginUser, loginPass, loginShow,
   loginError, loginBtn, loginHint, demoAccounts, demoList. */
window.LocateAuth = (function () {
  'use strict';

  const ROLE_LABEL = { customer: 'Customer', admin: 'Control admin' };
  const SESSION_HOURS = 12;

  // Dummy accounts for the demo (invented people). `demoPw` is only there so the
  // sign-in page can offer one-tap demo logins; set SHOW_DEMO_ACCOUNTS to false
  // to hide that list.
  const SHOW_DEMO_ACCOUNTS = true;
  const accounts = [
    { role: 'customer', user: 'customer', name: 'Demo Customer', hash: '15639ef8afccd5', demoPw: 'customer123' },
    { role: 'customer', user: 'priya', name: 'Priya Sharma', hash: 'f8ead09f7a053', demoPw: 'priya123' },
    { role: 'customer', user: 'arjun', name: 'Arjun Rao', hash: '170638ba5f7742', demoPw: 'arjun123' },
    { role: 'customer', user: 'meera', name: 'Meera Nair', hash: '1ea2eb0bab150b', demoPw: 'meera123' },
    { role: 'admin', user: 'admin', name: 'Control Admin', hash: '13ec2bc97709d1', demoPw: 'admin123' },
    { role: 'admin', user: 'control', name: 'Control Room 2', hash: '1f2fc898539334', demoPw: 'control123' }
  ];

  const $ = (id) => document.getElementById(id);
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };

  // Passwords changed by an admin, saved per browser: { "<username>": "<hash>" }
  let overrides = load('locate.accounts.v2', {});

  // Accounts people created with "Create account" (customers), saved on this device
  const custom = load('locate.accounts.custom', []);
  custom.forEach((a) => { if (!accounts.some((x) => x.user === a.user)) accounts.push(a); });

  // Small non-cryptographic hash (cyrb53) so passwords are not kept as plain text
  function hashPw(pw) {
    const str = 'locate|' + pw;
    let h1 = 0xdeadbeef ^ 7, h2 = 0x41c6ce57 ^ 7;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  function check(role, user, pw) {
    const acc = accounts.find((a) => a.role === role && a.user === String(user).trim().toLowerCase());
    if (!acc || hashPw(pw) !== (overrides[acc.user] || acc.hash)) return null;
    return { role: acc.role, user: acc.user, name: acc.name, ts: Date.now() };
  }

  // New customer account. Returns { session } or { error }.
  function createAccount(name, user, pw) {
    name = String(name || '').trim();
    user = String(user || '').trim().toLowerCase();
    if (name.length < 2) return { error: 'Enter your name.' };
    if (!/^[a-z0-9._-]{3,20}$/.test(user)) return { error: 'Username: 3-20 letters, numbers, dots, dashes or underscores.' };
    if (accounts.some((a) => a.user === user)) return { error: 'That username is taken. Try another one.' };
    if (String(pw || '').length < 6) return { error: 'The password needs 6 characters or more.' };
    const acc = { role: 'customer', user: user, name: name.slice(0, 40), hash: hashPw(pw), custom: true, created: Date.now() };
    accounts.push(acc);
    custom.push(acc);
    save('locate.accounts.custom', custom);
    return { session: { role: 'customer', user: user, name: acc.name, ts: Date.now() } };
  }

  function setPassword(user, pw) {
    overrides[user] = hashPw(pw);
    save('locate.accounts.v2', overrides);
  }
  function resetPasswords() {
    overrides = {};
    save('locate.accounts.v2', overrides);
  }

  // The sign-in belongs to the TAB (sessionStorage), so two people can be signed
  // in side by side in one browser - e.g. a customer in one tab and the control
  // admin in another - and a reload keeps each tab on its own account.
  // localStorage only remembers the last account, so a newly opened tab or the
  // installed app starts signed in.
  function tabSession() {
    try { const v = sessionStorage.getItem('locate.session'); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function savedSession() {
    const s = tabSession() || load('locate.session', null);
    const ok = s && accounts.some((a) => a.user === s.user && a.role === s.role) &&
      Date.now() - s.ts < SESSION_HOURS * 3600000;
    return ok ? s : null;
  }
  function saveSession(s) {
    try { sessionStorage.setItem('locate.session', JSON.stringify(s)); } catch (e) { /* private mode */ }
    save('locate.session', s);
  }
  function clearSession() {
    const mine = tabSession();
    try { sessionStorage.removeItem('locate.session'); } catch (e) { /* ignore */ }
    // Forget the remembered account only if it is this tab's own: signing out
    // here must not sign out a different person in another tab.
    const last = load('locate.session', null);
    if (!mine || !last || last.user === mine.user) { try { localStorage.removeItem('locate.session'); } catch (e) { /* ignore */ } }
  }

  // Wires up the sign-in form on the current page.
  //   opts.hints      { customer: '...', admin: '...' }  text under the button per tab
  //   opts.onSignedIn function (session)
  // Returns { show(), hide() }.
  function attachLogin(opts) {
    let role = 'customer';
    let fails = 0, lockedUntil = 0;

    function demoList() {
      const list = $('demoList');
      list.textContent = '';
      // Every demo account, admins first, whichever tab is selected. One tap signs in.
      const shown = SHOW_DEMO_ACCOUNTS ? accounts.filter((a) => a.demoPw && !overrides[a.user])
        .sort((x, y) => (x.role === y.role ? 0 : x.role === 'admin' ? -1 : 1)) : [];
      $('demoAccounts').hidden = shown.length === 0;
      shown.forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'demo-acc';
        const n = document.createElement('strong'); n.textContent = a.name;
        const c = document.createElement('span'); c.textContent = ROLE_LABEL[a.role] + ' · ' + a.user;
        b.appendChild(n); b.appendChild(c);
        b.setAttribute('aria-label', 'Sign in as ' + a.name + ', ' + ROLE_LABEL[a.role]);
        b.addEventListener('click', () => {
          const session = check(a.role, a.user, a.demoPw);
          if (session) { fails = 0; opts.onSignedIn(session); }
          else fail('This demo account no longer works on this device.');
        });
        list.appendChild(b);
      });
    }

    function setRole(r) {
      role = r;
      $('roleCustomer').setAttribute('aria-pressed', String(r === 'customer'));
      $('roleAdmin').setAttribute('aria-pressed', String(r === 'admin'));
      $('loginHint').textContent = (opts.hints && opts.hints[r]) || '';
      $('loginError').textContent = '';
      demoList();
    }

    function fail(msg) {
      $('loginError').textContent = '✕ ' + msg;
      const card = $('loginForm');
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    }

    // "Create account" mode (only on pages that have the sign-up elements)
    let signup = false;
    function setSignup(on) {
      if (!$('signupToggle')) return;
      signup = on;
      $('loginForm').dataset.mode = on ? 'signup' : 'signin';
      $('loginTitle').textContent = on ? 'Create your account' : 'Sign in';
      $('loginBtn').textContent = on ? 'Create account' : 'Sign in';
      $('signupNameRow').hidden = !on;
      $('signupToggle').textContent = on ? 'Already have an account? Sign in' : 'New here? Create a free account';
      $('loginPass').setAttribute('autocomplete', on ? 'new-password' : 'current-password');
      $('loginError').textContent = '';
      if (on) setRole('customer');
      $('loginHint').textContent = on ? 'Add your vehicles, pair a tracker and get theft alerts on this phone.'
        : ((opts.hints && opts.hints[role]) || '');
      setTimeout(() => (on ? $('signupName') : $('loginUser')).focus(), 30);
    }

    function submit() {
      const now = Date.now();
      if (signup) {
        const r = createAccount($('signupName').value, $('loginUser').value, $('loginPass').value);
        if (r.error) { fail(r.error); return; }
        $('loginPass').value = ''; $('signupName').value = '';
        setSignup(false);
        demoList();
        opts.onSignedIn(r.session, { created: true });
        return;
      }
      if (now < lockedUntil) { fail('Too many tries. Wait ' + Math.ceil((lockedUntil - now) / 1000) + ' seconds.'); return; }
      const user = $('loginUser').value, pw = $('loginPass').value;
      if (!user.trim() || !pw) { fail('Enter your username and password.'); return; }
      const session = check(role, user, pw);
      if (session) {
        fails = 0;
        $('loginPass').value = '';
        opts.onSignedIn(session);
        return;
      }
      fails++;
      if (fails >= 5) { fails = 0; lockedUntil = now + 30000; fail('Too many tries. Wait 30 seconds.'); return; }
      // Same message for a wrong name, wrong password or wrong tab: do not hint which
      fail('Wrong username or password for ' + ROLE_LABEL[role] + '.');
      $('loginPass').select();
    }

    $('roleCustomer').addEventListener('click', () => setRole('customer'));
    $('roleAdmin').addEventListener('click', () => setRole('admin'));
    $('loginForm').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    $('loginShow').addEventListener('click', () => {
      const show = $('loginPass').type === 'password';
      $('loginPass').type = show ? 'text' : 'password';
      $('loginShow').textContent = show ? 'Hide' : 'Show';
      $('loginShow').setAttribute('aria-pressed', String(show));
    });
    if ($('signupToggle')) $('signupToggle').addEventListener('click', () => setSignup(!signup));
    setRole('customer');

    return {
      show() {
        $('login').hidden = false;
        $('loginPass').value = '';
        $('loginError').textContent = '';
        demoList();
        setTimeout(() => $('loginUser').focus(), 50);
      },
      hide() { $('login').hidden = true; }
    };
  }

  return {
    ROLE_LABEL: ROLE_LABEL, accounts: accounts,
    check: check, createAccount: createAccount, setPassword: setPassword, resetPasswords: resetPasswords,
    savedSession: savedSession, saveSession: saveSession, clearSession: clearSession,
    attachLogin: attachLogin
  };
})();
