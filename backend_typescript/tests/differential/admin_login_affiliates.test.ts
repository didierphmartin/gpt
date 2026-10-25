/**
 * Differential tests for LoginAdminController + AffiliateController — twin of
 * backend_python/tests/differential/test_admin_login_affiliates.py.
 *
 * PHP live at DIFF_PHP_BASE, TS in-process. User 3 (must be `role = admin` in the shared contexts
 * DB for the admin-gated GETs below to return 200 rather than a matched 403 on both backends).
 *
 * Self-cleaning: every mutation this file makes is undone in a `finally` block, and the round-trip
 * tests assert the affected list is byte-identical before and after. `POST /affiliate/conversions`
 * is exercised for VALIDATION ONLY — every case is built so no sale is ever recorded (bad bodies,
 * and a ref that cannot match a real affiliate key).
 *
 * WRITES (dtest.write): test_affiliate_product_round_trip,
 * test_affiliate_create_add_account_mark_paid_delete_round_trip, test_login_admin_user_round_trip
 * (the last writes the LOGIN DB). The not-found DELETE/PUT on id 999999999 match no row and stay
 * read cases, as in Python.
 */
import { dtest, same, assert } from './harness';

// ─── GET parity (admin user) ────────────────────────────────────────────────

dtest('test_login_admin_gets_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/admin/login/stats')));
  same(...(await hx.both('GET', '/api/v1/admin/login/users')));
  same(...(await hx.both('GET', '/api/v1/admin/login/apps')));
  // Bogus slug — deterministic on both backends regardless of whether the login DB is
  // configured/reachable (either both say "Login DB not reachable", or both "Unknown application").
  same(...(await hx.both('GET', '/api/v1/admin/login/app-users?app=differential-tmp-nonexistent-app')));
});

dtest('test_login_admin_unauthenticated_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/admin/login/stats', { auth: false })));
});

dtest('test_affiliate_admin_gets_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/admin/affiliates')));
  same(...(await hx.both('GET', '/api/v1/admin/affiliate-products')));
});

dtest('test_affiliate_admin_not_found_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/admin/affiliates/999999999')));
  same(...(await hx.both('DELETE', '/api/v1/admin/affiliates/999999999')));
  same(...(await hx.both('GET', '/api/v1/admin/affiliates/999999999/transactions')));
  same(...(await hx.both('PUT', '/api/v1/admin/affiliate-products/999999999', { json: { name: 'x', sales_page_url: 'y' } })));
});

// ─── self-scope parity: user 3 is admin, NOT an affiliate ──────────────────

dtest('test_affiliate_me_parity_for_non_affiliate_admin', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/affiliate/me')));
  same(...(await hx.both('GET', '/api/v1/affiliate/me/transactions')));
});

// ─── public conversion endpoint: validation only, never records a sale ─────

dtest('test_conversions_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/affiliate/conversions', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/affiliate/conversions', { json: { ref: 'x', product: 0, amount: 5 } })));
  same(...(await hx.both('POST', '/api/v1/affiliate/conversions', { json: { ref: '', product: 1, amount: 5 } })));
  same(...(await hx.both('POST', '/api/v1/affiliate/conversions', { json: { ref: 'x', product: 1, amount: 0 } })));
  // Deliberately unmatchable — findAffiliateByKey() returns none on both backends, so no
  // product/account/commission logic (and no INSERT) runs.
  same(...(await hx.both('POST', '/api/v1/affiliate/conversions', {
    json: { ref: 'differential-tmp-nonexistent-affiliate-key', product: 1, amount: 10 },
  })));
  same(...(await hx.both('POST', '/api/v1/affiliate/conversions', { json: { ref: 'x', product: 1, amount: 5 }, auth: false })));
});

// ─── round trip: affiliate product — WRITES ─────────────────────────────────

dtest.write('test_affiliate_product_round_trip', async (hx) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/admin/affiliate-products', { headers: h })).json();
    assert.equal(before.success, true);

    const created = await c.post('/api/v1/admin/affiliate-products', {
      json: {
        name: 'differential-tmp-product', sales_page_url: 'https://example.com/tmp',
        commission_type: 'percent', commission_value: 15, currency: 'usd', active: true,
      },
      headers: h,
    });
    assert.equal(created.status, 200, created.text);
    const cj = created.json();
    assert.equal(cj.success, true);
    const pid = cj.product_id;

    try {
      const updated = await c.put(`/api/v1/admin/affiliate-products/${pid}`, {
        json: { name: 'differential-tmp-product-2', sales_page_url: 'https://example.com/tmp2', commission_type: 'fixed', commission_value: 5 },
        headers: h,
      });
      assert.equal(updated.status, 200, updated.text);
      assert.deepStrictEqual(updated.json(), { success: true });
    } finally {
      const deleted = await c.delete(`/api/v1/admin/affiliate-products/${pid}`, { headers: h });
      assert.equal(deleted.status, 200, deleted.text);
      assert.deepStrictEqual(deleted.json(), { success: true });
    }

    const after = (await c.get('/api/v1/admin/affiliate-products', { headers: h })).json();
    assert.deepStrictEqual(after, before);
  }
});

// ─── round trip: affiliate + account + mark-nothing-paid — WRITES ──────────

/**
 * PHP first, so PHP's on-demand state lands before TS touches the same rows. `mark-paid` targets a
 * sale id that can never exist, so it always resolves to `updated: 0` — no ledger row is mutated.
 */
dtest.write('test_affiliate_create_add_account_mark_paid_delete_round_trip', async (hx) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const beforeAffiliates = (await c.get('/api/v1/admin/affiliates', { headers: h })).json();
    assert.equal(beforeAffiliates.success, true);
    const beforeProducts = (await c.get('/api/v1/admin/affiliate-products', { headers: h })).json();
    assert.equal(beforeProducts.success, true);

    let affId: number | null = null;
    let pid: number | null = null;
    try {
      const created = await c.post('/api/v1/admin/affiliates', {
        json: { name: 'differential-tmp-affiliate', email: 'differential-tmp-affiliate@example.com', password: 'Tmp-Passw0rd!' },
        headers: h,
      });
      assert.equal(created.status, 200, created.text);
      const cj = created.json();
      assert.equal(cj.success, true);
      assert.equal(cj.existing_user, false);
      affId = cj.affiliate_id;

      const product = await c.post('/api/v1/admin/affiliate-products', {
        json: { name: 'differential-tmp-product-for-affiliate', sales_page_url: 'https://example.com/tmp-aff' },
        headers: h,
      });
      assert.equal(product.status, 200, product.text);
      const pj = product.json();
      assert.equal(pj.success, true);
      pid = pj.product_id;

      const added = await c.post(`/api/v1/admin/affiliates/${affId}/accounts`, { json: { product_id: pid }, headers: h });
      assert.equal(added.status, 200, added.text);
      assert.deepStrictEqual(added.json(), { success: true });

      const marked = await c.post(`/api/v1/admin/affiliates/${affId}/transactions/999999999/mark-paid`, { headers: h });
      assert.equal(marked.status, 200, marked.text);
      assert.deepStrictEqual(marked.json(), { success: true, updated: 0 });
    } finally {
      // Delete the affiliate FIRST — its account row (FK'd to both the affiliate and the product)
      // cascades away with it, so the tmp product can then be deleted cleanly.
      if (affId !== null) {
        const deletedAff = await c.delete(`/api/v1/admin/affiliates/${affId}`, { headers: h });
        assert.equal(deletedAff.status, 200, deletedAff.text);
        assert.deepStrictEqual(deletedAff.json(), { success: true });
      }
      if (pid !== null) {
        const deletedProd = await c.delete(`/api/v1/admin/affiliate-products/${pid}`, { headers: h });
        assert.equal(deletedProd.status, 200, deletedProd.text);
        assert.deepStrictEqual(deletedProd.json(), { success: true });
      }
    }

    assert.deepStrictEqual((await c.get('/api/v1/admin/affiliates', { headers: h })).json(), beforeAffiliates);
    assert.deepStrictEqual((await c.get('/api/v1/admin/affiliate-products', { headers: h })).json(), beforeProducts);
  }
});

// ─── round trip: login-admin user create/update/delete — WRITES (login DB) ─

dtest.write('test_login_admin_user_round_trip', async (hx, t) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/admin/login/users', { headers: h })).json();
    assert.equal(before.success, true);
    if (before.available === false) {
      t.skip(`Login DB not reachable from ${c.base} — nothing to round-trip`);
      return;
    }

    const created = await c.post('/api/v1/admin/login/users', {
      json: { email: 'differential-tmp-login@example.com', first_name: 'Tmp' }, headers: h,
    });
    assert.equal(created.status, 200, created.text);
    const cj = created.json();
    assert.equal(cj.success, true);
    const uid = cj.id;

    try {
      const updated = await c.post('/api/v1/admin/login/users/update', { json: { id: uid, first_name: 'TmpUpdated' }, headers: h });
      assert.equal(updated.status, 200, updated.text);
      assert.deepStrictEqual(updated.json(), { success: true });
    } finally {
      const deleted = await c.post('/api/v1/admin/login/users/delete', { json: { id: uid }, headers: h });
      assert.equal(deleted.status, 200, deleted.text);
      assert.deepStrictEqual(deleted.json(), { success: true });
    }

    assert.deepStrictEqual((await c.get('/api/v1/admin/login/users', { headers: h })).json(), before);
  }
});
