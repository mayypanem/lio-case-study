const BASE = "http://localhost:7200";

async function main() {
  const signin = await fetch(`${BASE}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@acme.com", password: "demo1234" }),
  });
  const { access_token } = await signin.json();
  const auth = { Authorization: `Bearer ${access_token}` };

  // --- Supplier match: VAT exact ---
  const suppliersRes = await fetch(`${BASE}/suppliers?search=Rheinwerk`, { headers: auth });
  const suppliers = await suppliersRes.json();
  console.log("Suppliers found:", suppliers.map((s) => ({ id: s.id, name: s.name, vat: s.vat_id })));
  const target = suppliers[0];

  const vatMatch = await fetch(
    `${BASE}/suppliers/match?${new URLSearchParams({ name: "Totally Wrong Name", vat_id: target.vat_id })}`,
    { headers: auth }
  );
  console.log("\nVAT exact match:", JSON.stringify(await vatMatch.json(), null, 2));

  const nameMatch = await fetch(
    `${BASE}/suppliers/match?${new URLSearchParams({ name: "Rheinwerk Systms GmbH" })}`,
    { headers: auth }
  );
  console.log("\nFuzzy name match (typo):", JSON.stringify(await nameMatch.json(), null, 2));

  const noMatch = await fetch(
    `${BASE}/suppliers/match?${new URLSearchParams({ name: "Zzzzzzz Totally Unrelated Inc" })}`,
    { headers: auth }
  );
  console.log("\nNo match expected:", JSON.stringify(await noMatch.json(), null, 2));

  // --- Article match ---
  const articlesRes = await fetch(`${BASE}/articles?supplier_id=${target.id}&limit=50`, { headers: auth });
  const articlesPage = await articlesRes.json();
  console.log(
    "\nSupplier's articles:",
    articlesPage.items.map((a) => ({ number: a.article_number, desc: a.description }))
  );
  const sample = articlesPage.items.find((a) => a.article_number === "RHE-00004") || articlesPage.items[0];

  const articleMatch = await fetch(`${BASE}/articles/match`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      supplierId: target.id,
      lines: [
        { index: 0, description: sample.description }, // exact
        { index: 1, description: "Business laptop 14 inch" }, // fuzzy
        { index: 2, description: "zzzzz qqqqq unrelated gibberish" }, // no match
      ],
    }),
  });
  console.log("\nArticle match result:", JSON.stringify(await articleMatch.json(), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
