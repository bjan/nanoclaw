#!/usr/bin/env python3
"""NanoClaw Codex Proxy — CLI entry point.

Usage:
    python -m codex-proxy serve [--host HOST] [--port PORT]
    python -m codex-proxy auth add [--label NAME] [--manual]
    python -m codex-proxy auth list
    python -m codex-proxy auth remove <id>
    python -m codex-proxy auth refresh [<id>]
"""
from __future__ import annotations

import argparse
import sys
import time

from .accounts import AccountStore


def cmd_serve(args: argparse.Namespace) -> None:
    from .server import serve
    serve(host=args.host, port=args.port)


def cmd_auth_add(args: argparse.Namespace) -> None:
    from .auth import run_auth_flow
    store = AccountStore()
    store.load()
    tokens = run_auth_flow(label=args.label, manual=args.manual)
    acct = store.add(tokens)
    print(f"Added account {acct.id} ({acct.label})")
    print(f"  account_id: {acct.account_id}")
    print(f"  expires_at: {time.ctime(acct.expires_at)}")


def cmd_auth_list(args: argparse.Namespace) -> None:
    store = AccountStore()
    store.load()
    if not store.accounts:
        print("No accounts configured.")
        return
    for a in store.accounts:
        status = "expired" if a.is_expired else "valid"
        print(f"  {a.id}  {a.label:20s}  {status}  account_id={a.account_id}")


def cmd_auth_remove(args: argparse.Namespace) -> None:
    store = AccountStore()
    store.load()
    if store.remove(args.id):
        print(f"Removed {args.id}")
    else:
        print(f"Account {args.id} not found")
        sys.exit(1)


def cmd_auth_refresh(args: argparse.Namespace) -> None:
    store = AccountStore()
    store.load()
    targets = store.accounts if not args.id else [a for a in store.accounts if a.id == args.id]
    if not targets:
        print("No matching accounts")
        sys.exit(1)
    for acct in targets:
        try:
            store.refresh(acct)
            print(f"  {acct.id}: refreshed, expires {time.ctime(acct.expires_at)}")
        except Exception as e:
            print(f"  {acct.id}: refresh failed — {e}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="codex-proxy", description="NanoClaw Codex Proxy")
    sub = parser.add_subparsers(dest="command")

    serve_p = sub.add_parser("serve", help="Start the proxy server")
    serve_p.add_argument("--host", default="0.0.0.0")
    serve_p.add_argument("--port", type=int, default=8741)

    auth_p = sub.add_parser("auth", help="Manage OAuth accounts")
    auth_sub = auth_p.add_subparsers(dest="auth_command")

    add_p = auth_sub.add_parser("add", help="Add a new account via OAuth")
    add_p.add_argument("--label", default="")
    add_p.add_argument("--manual", action="store_true", help="Headless mode (paste redirect URL)")

    auth_sub.add_parser("list", help="List accounts")

    rm_p = auth_sub.add_parser("remove", help="Remove an account")
    rm_p.add_argument("id")

    ref_p = auth_sub.add_parser("refresh", help="Force-refresh tokens")
    ref_p.add_argument("id", nargs="?", default=None)

    args = parser.parse_args()

    if args.command == "serve":
        cmd_serve(args)
    elif args.command == "auth":
        if args.auth_command == "add":
            cmd_auth_add(args)
        elif args.auth_command == "list":
            cmd_auth_list(args)
        elif args.auth_command == "remove":
            cmd_auth_remove(args)
        elif args.auth_command == "refresh":
            cmd_auth_refresh(args)
        else:
            auth_p.print_help()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
