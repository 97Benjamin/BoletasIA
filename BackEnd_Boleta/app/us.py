import os
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

client = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
response = client.auth.sign_in_with_password({
    "email": "aaranedaa@gmail.com",
    "password": "Elveet12"
})

print("JWT Token:", response.session.access_token)