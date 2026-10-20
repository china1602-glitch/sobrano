/* Снимки магазинных цен хранятся отдельно от учебных оценок. */
(function (root) {
  "use strict";
  const raw = Array.isArray(root.SOBRANO_OFFERS) ? root.SOBRANO_OFFERS : [];
  const offers = raw.filter(
    (offer) =>
      /^p\d+$/.test(offer.productId) &&
      offer.currency === "KZT" &&
      Number.isFinite(offer.price) &&
      offer.price > 0 &&
      /^https:\/\//.test(offer.url) &&
      Number.isFinite(Date.parse(offer.checkedAt)),
  );
  function offersFor(product) {
    return offers.filter((offer) => offer.productId === product.id);
  }
  function price(product, now = Date.now()) {
    const current = offersFor(product)
      .filter((offer) => {
        const age = now - Date.parse(offer.checkedAt);
        return (
          age >= -300000 &&
          age <= 30 * 86400000 &&
          offer.availability !== "out-of-stock"
        );
      })
      .sort((a, b) => a.price - b.price);
    return current.length
      ? {
          value: current[0].price,
          kind: "snapshot",
          offer: current[0],
          count: current.length,
        }
      : { value: product.price, kind: "estimate", offer: null, count: 0 };
  }
  function budget(parts, products, now = Date.now()) {
    let value = 0,
      snapshots = 0,
      estimates = 0;
    for (const index of Object.values(parts)) {
      if (!Number.isInteger(index) || !products[index]) continue;
      const item = price(products[index], now);
      value += item.value || 0;
      item.kind === "snapshot" ? snapshots++ : estimates++;
    }
    return { value, snapshots, estimates };
  }
  root.SobranoPricing = { offers, offersFor, price, budget };
  if (typeof module === "object" && module.exports)
    module.exports = root.SobranoPricing;
})(typeof window === "object" ? window : globalThis);
