
const productList = document.querySelector("#product-list");

fetch("data/products.json")
    .then(response => {
        if (!response.ok) {
            throw new Error("Ошибка загрузки данных");
        }
        return response.json();
    })
    .then(products => {
        productList.innerHTML = "";

        products.forEach(product => {
            const card = document.createElement("article");
            card.className = "product-card";

            const title = document.createElement("h3");
            title.textContent = product.name;

            const specs = document.createElement("p");
            specs.textContent = product.specs
                .map(item => `${item.label}: ${item.value}`)
                .join(" · ");

            const link = document.createElement("a");
            link.href = product.source;
            link.textContent = "Характеристики производителя";
            link.target = "_blank";
            link.rel = "noopener noreferrer";

            card.append(title, specs, link);
            productList.append(card);
        });
    })
    .catch(error => {
        console.error(error);
        productList.textContent = "Не удалось загрузить товары.";
    });
