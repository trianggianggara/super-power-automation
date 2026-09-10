#!/bin/bash

# Jumlah thread default
THREADS=3

# Mendukung custom jumlah thread dari argumen pertama
if [ ! -z "$1" ]; then
  THREADS=$1
fi

echo "=== Menjalankan $THREADS Thread TokenGO secara Paralel ==="
pids=()

for ((i=0; i<THREADS; i++))
do
  echo "Memulai Thread $i (Logs: thread_$i.log)..."
  # Menjalankan script secara background dengan THREAD_INDEX masing-masing
  THREAD_INDEX=$i node register_tokengo.js > "thread_$i.log" 2>&1 &
  pids+=($!)
done

echo "Semua thread telah dijalankan. Menunggu proses selesai..."

# Menunggu seluruh PID selesai
for pid in "${pids[@]}"; do
  wait "$pid"
done

echo "=== Semua thread selesai dijalankan! ==="
