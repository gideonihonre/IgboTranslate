import translators as ts


def translate_to_igbo(text: str) -> dict:
    """Translate text to Igbo via Google Translate (scraped through `translators`).

    Note: this library works by scraping Google Translate rather than calling
    a paid API, which is why it needs no credentials — but it's more prone to
    breaking or rate-limiting under real traffic than the official
    google-cloud-translate v3 client that's also sketched out in the original
    backend repo. If you start seeing failures under load, that's the first
    thing to swap in.
    """
    result = ts.translate_text(
        text, to_language="ig", translator="google", is_detail_result=True
    )
    return {
        "text": result["data"][1][0][0][5][0][0],
        "detected_language": result["data"][0][2],
    }
