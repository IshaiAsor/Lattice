 CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY ,
        user_type INT NOT NULL DEFAULT 0, -- 0 for regular users, 1 for google users
        user_role VARCHAR(50) NOT NULL DEFAULT 'user', -- 'user' or 'admin'
        user_name VARCHAR(255) UNIQUE, -- Only for regular users
        password VARCHAR(255), -- Only for regular users
        google_id VARCHAR(255) UNIQUE,
        email VARCHAR(255) UNIQUE NOT NULL,
        full_name VARCHAR(255),
        profile_picture_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
