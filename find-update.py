p = r"C:\Users\kingt\AppData\Roaming\Python\Python314\site-packages\graphify\cli.py"
lines = open(p, encoding="utf-8").read().splitlines()
# 1. Find every add_parser call (subcommand registration) and its line
print("==== add_parser registrations ====")
for i, ln in enumerate(lines, 1):
    if ".add_parser(" in ln:
        print(f"{i}: {ln.strip()}")
print("==== add_argument with 'backend' ====")
for i, ln in enumerate(lines, 1):
    if "add_argument" in ln and "backend" in ln.lower():
        print(f"{i}: {ln.strip()}")
print("==== lines mentioning update (command dispatch) ====")
for i, ln in enumerate(lines, 1):
    s = ln.strip()
    if ("update" in s) and (("subcommand" in s) or ("==" in s) or ("args." in s) or ("def " in s)):
        print(f"{i}: {s}")

