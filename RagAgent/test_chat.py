import argparse

from app.agent import chat_with_pdf_agent


def run_test(chat_id: str, query: str):
    print(f"User: {query}")
    print("Agent: ", end="", flush=True)
    for chunk in chat_with_pdf_agent(user_query=query, chat_id=chat_id, history=[]):
        print(chunk, end="", flush=True)
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Smoke-test the RAG chat pipeline for an existing chat.")
    parser.add_argument("chat_id", help="Existing chat ID containing uploaded documents.")
    parser.add_argument("query", help="Question to ask the uploaded documents.")
    args = parser.parse_args()
    run_test(args.chat_id, args.query)
