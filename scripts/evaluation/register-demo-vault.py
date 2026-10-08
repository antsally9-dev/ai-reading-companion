import json, os, uuid

p = os.path.expandvars(r"%APPDATA%/obsidian/obsidian.json")
d = json.load(open(p, encoding="utf-8"))
vault_path = os.path.expandvars(r"%USERPROFILE%/Documents/arc-demo-vault").replace(os.sep, "/")

d["vaults"] = {
    k: v for k, v in d["vaults"].items()
    if v.get("path", "").replace(os.sep, "/") != vault_path
}
d["vaults"][uuid.uuid4().hex[:8].upper()] = {
    "path": vault_path, "ts": 1700000000000, "open": True,
}
for k, v in d["vaults"].items():
    v["open"] = v.get("path", "").replace(os.sep, "/") == vault_path

json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("registered:", vault_path)
