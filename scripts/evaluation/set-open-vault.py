import json
import os

path = os.path.join(os.environ["APPDATA"], "obsidian", "obsidian.json")
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)

target = os.environ.get("OPEN_VAULT_SUBSTRING", "mynotes")
for entry in data.get("vaults", {}).values():
    normalized = entry.get("path", "").replace("\\", "/")
    if normalized.endswith(target):
        entry["open"] = True
    else:
        entry.pop("open", None)

with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=1)
print(f"open vault -> {target}")
