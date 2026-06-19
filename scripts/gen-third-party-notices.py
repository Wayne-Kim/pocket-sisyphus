#!/usr/bin/env python3
# 3rd-party 라이선스 고지 자동 집계 — 디스크의 실제 LICENSE 원문에서 빠짐없이 수집.
import os, glob, json, subprocess, sys

ROOT = subprocess.run(["git","rev-parse","--show-toplevel"],
                      capture_output=True, text=True).stdout.strip() or os.getcwd()
def find_license(d):
    for pat in ("LICENSE*", "LICENCE*", "COPYING*", "license*"):
        for f in sorted(glob.glob(os.path.join(d, pat))):
            if os.path.isfile(f):
                try:
                    return open(f, encoding="utf-8", errors="replace").read().strip()
                except Exception:
                    pass
    return None

def section(name, ver, url, text):
    head = f"### {name}" + (f" {ver}" if ver else "") + (f"\n{url}" if url else "")
    return f"{head}\n\n{text}\n\n" + ("-" * 78) + "\n\n"

MIT_T = """MIT License

Copyright (c) {h}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""

ISC_T = """ISC License

Copyright (c) {h}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE."""

def _author(j):
    a = j.get("author")
    if isinstance(a, dict): return a.get("name", "")
    if isinstance(a, str): return a.split("<")[0].strip()
    return ""

def fallback_text(j, name):
    lic = j.get("license")
    if isinstance(lic, dict): lic = lic.get("type")
    if not isinstance(lic, str): return None
    h = _author(j) or f"the {name} authors"
    L = lic.upper()
    if L == "MIT": return MIT_T.format(h=h)
    if L == "ISC": return ISC_T.format(h=h)
    return (f"License: {lic}\nCopyright (c) {h}\n\n"
            "(No license file was bundled with this package; SPDX identifier shown above.)")

# ---------- iOS ----------
def _find_checkouts():
    for c in (glob.glob(os.path.join(ROOT, "build/*/SourcePackages/checkouts"))
              + glob.glob(os.path.join(ROOT, "ios/build/*/SourcePackages/checkouts"))
              + glob.glob(os.path.join(ROOT, "*/build/*/SourcePackages/checkouts"))):
        # iOS 전용 패키지까지 모두 있는 checkouts 만 (Mac 부분집합 오선택 방지)
        if all(os.path.isdir(os.path.join(c, p))
               for p in ("Citadel", "WhisperKit", "Runestone", "SwiftTerm")):
            return c
    raise SystemExit("iOS SPM checkouts(전체) 못 찾음 — iOS 스킴 1회 빌드 후 재실행")
ck_ios = _find_checkouts()
ios_spm = ["BigInt","Citadel","Runestone","swift-argument-parser","swift-asn1",
 "swift-atomics","swift-collections","swift-crypto","swift-jinja","swift-log",
 "swift-nio","swift-nio-ssh","swift-system","swift-transformers","SwiftTerm",
 "tree-sitter","TreeSitterLanguages","WhisperKit","yyjson"]
ios_out, ios_missing = [], []
for p in ios_spm:
    d = os.path.join(ck_ios, p)
    t = find_license(d)
    if t: ios_out.append(section(p, "", "", t))
    else: ios_missing.append(p)
# Tor (iOS: Tor.framework)
tor_lic = find_license(os.path.join(ROOT, "ios/Pods/Tor"))
if tor_lic: ios_out.append(section("Tor (Tor.framework, iOS)", "", "https://www.torproject.org", tor_lic))
else: ios_missing.append("Tor(iOS)")

# ---------- Mac SPM ----------
mac_out, mac_missing = [], []
spk = glob.glob(os.path.join(ROOT, "mac/build/*/SourcePackages/checkouts/Sparkle"))
for name, dirs in [
    ("Sparkle", spk),
    ("swift-argument-parser", [os.path.join(ck_ios, "swift-argument-parser")]),
    ("SwiftTerm", [os.path.join(ck_ios, "SwiftTerm")]),
]:
    t = next((find_license(d) for d in dirs if d and os.path.isdir(d) and find_license(d)), None)
    if t: mac_out.append(section(name, "", "", t))
    else: mac_missing.append(name)

# ---------- Mac: daemon npm (prod, transitive 포함) ----------
paths = subprocess.run(["npm","ls","--omit=dev","--all","--parseable"],
        cwd=os.path.join(ROOT,"mac/daemon"), capture_output=True, text=True).stdout.split("\n")
seen=set(); npm_out=[]; npm_missing=[]
for d in paths:
    d=d.strip()
    if not d or "/node_modules/" not in d: continue
    rp=os.path.realpath(d)
    if rp in seen: continue
    seen.add(rp)
    pj=os.path.join(rp,"package.json")
    name=os.path.basename(rp); ver=""; url=""; j={}
    if os.path.isfile(pj):
        try:
            j=json.load(open(pj))
            name=j.get("name",name); ver=j.get("version","")
            r=j.get("repository"); url=(r.get("url") if isinstance(r,dict) else r) or j.get("homepage","")
        except Exception: j={}
    t=find_license(rp) or fallback_text(j,name)
    if t: npm_out.append((name,section(name,ver,url,t)))
    else: npm_missing.append(name)
npm_out.sort(key=lambda x:x[0].lower())

# ---------- Mac: bundled binaries ----------
bin_out=[]
if tor_lic: bin_out.append(section("Tor (bundled tor binary, macOS)","","https://www.torproject.org",tor_lic))
ossh=None
for c in glob.glob("/opt/homebrew/Cellar/openssh/*/")+["/opt/homebrew/opt/openssh"]:
    for f in ("LICENCE","LICENSE"):
        p=os.path.join(c,f)
        if os.path.isfile(p): ossh=open(p,errors="replace").read().strip(); break
    if ossh: break
if ossh: bin_out.append(section("OpenSSH (bundled sshd/sshd-session/sshd-auth)","","https://www.openssh.com",ossh))
else: mac_missing.append("OpenSSH")

hdr=("Pocket Sisyphus — Third-Party Notices\n"
 "이 앱은 아래 오픈소스 컴포넌트를 포함하며, 각 라이선스 원문을 그대로 고지합니다.\n"
 "This application bundles the following open-source components; their license texts are reproduced below.\n\n"+("="*78)+"\n\n")

ios_path=os.path.join(ROOT,"ios/PocketSisyphus/THIRD-PARTY-NOTICES.txt")
mac_path=os.path.join(ROOT,"mac/PocketSisyphusMac/THIRD-PARTY-NOTICES.txt")
open(ios_path,"w",encoding="utf-8").write(hdr+"".join(ios_out))
open(mac_path,"w",encoding="utf-8").write(hdr+"".join(mac_out)+"".join(s for _,s in npm_out)+"".join(bin_out))

print(f"iOS:  SPM {len(ios_spm)} + Tor → 섹션 {len(ios_out)}개, 누락 {ios_missing}")
print(f"Mac:  SPM 3 → {len(mac_out)}개, npm {len(npm_out)}개, 바이너리 {len(bin_out)}개, SPM/바이너리 누락 {mac_missing}")
print(f"  npm 라이선스 미확보(완전 누락): {npm_missing or '없음 ✅'}")
print(f"  iOS 파일 {os.path.getsize(ios_path)//1024}KB · Mac 파일 {os.path.getsize(mac_path)//1024}KB")
