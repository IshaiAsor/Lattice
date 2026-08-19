#pragma once
// Leveled logging. Usage:
//
//     LOG_I("Mqtt", "connected to %s:%d", host, port);   // → [I][Mqtt] connected to ...
//
// Tags are string literals (concatenated at compile time). Levels below LOG_LEVEL compile
// to ((void)0) — zero flash and zero cycles. Override per env with -D LOG_LEVEL=LOG_LEVEL_x.
//
// The default is DEBUG for every build, prod included. Prod used to drop to INFO to keep the
// DEBUG format strings out of the image (the biggest single flash lever here), but a camera
// that reported itself healthy while never producing a frame was undiagnosable on a shipped
// build — the deciding lines were all LOG_D. Field diagnosability won; if the mini's 1.92 MB
// OTA slot gets tight again, put `-D LOG_LEVEL=LOG_LEVEL_INFO` back on the specific env
// rather than re-introducing a blanket prod/test split.
//
// Log output only — Serial.begin(), the boot CDC wait, and progress dots stay raw Serial.

#define LOG_LEVEL_NONE 0
#define LOG_LEVEL_ERROR 1
#define LOG_LEVEL_WARN 2
#define LOG_LEVEL_INFO 3
#define LOG_LEVEL_DEBUG 4

#ifndef LOG_LEVEL
#define LOG_LEVEL LOG_LEVEL_DEBUG
#endif

// Host builds (manifest generator, native unit tests) have no Serial.
#ifdef ARDUINO
#include <Arduino.h>
#define LOG_PRINTF_(...) Serial.printf(__VA_ARGS__)
#else
#include <cstdio>
#define LOG_PRINTF_(...) std::printf(__VA_ARGS__)
#endif

#if LOG_LEVEL >= LOG_LEVEL_ERROR
#define LOG_E(tag, fmt, ...) LOG_PRINTF_("[E][" tag "] " fmt "\n", ##__VA_ARGS__)
#else
#define LOG_E(tag, fmt, ...) ((void)0)
#endif

#if LOG_LEVEL >= LOG_LEVEL_WARN
#define LOG_W(tag, fmt, ...) LOG_PRINTF_("[W][" tag "] " fmt "\n", ##__VA_ARGS__)
#else
#define LOG_W(tag, fmt, ...) ((void)0)
#endif

#if LOG_LEVEL >= LOG_LEVEL_INFO
#define LOG_I(tag, fmt, ...) LOG_PRINTF_("[I][" tag "] " fmt "\n", ##__VA_ARGS__)
#else
#define LOG_I(tag, fmt, ...) ((void)0)
#endif

#if LOG_LEVEL >= LOG_LEVEL_DEBUG
#define LOG_D(tag, fmt, ...) LOG_PRINTF_("[D][" tag "] " fmt "\n", ##__VA_ARGS__)
#else
#define LOG_D(tag, fmt, ...) ((void)0)
#endif
