const out = document.getElementById('out');
const response = await fetch('/prod/api/objects?id=3&id=5');
out.textContent = `GET /api/objects?id=3&id=5 -> ${response.status}\n${await response.text()}`;
