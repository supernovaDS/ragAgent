import cloudinary.uploader
import cloudinary.api
from app.config import settings

def test_cloudinary():
    print(f"Cloud Name configured: {settings.CLOUDINARY_CLOUD_NAME}")
    try:
        # Check API connection by pinging
        res = cloudinary.api.ping()
        if res.get("status") == "ok":
            print("✅ Successfully connected to Cloudinary API!")
        else:
            print("❌ Connection failed.")
    except Exception as e:
        print(f"❌ Error connecting to Cloudinary: {e}")

if __name__ == "__main__":
    test_cloudinary()
