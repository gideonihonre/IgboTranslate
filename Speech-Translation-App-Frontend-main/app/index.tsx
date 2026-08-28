// app/index.tsx
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';

export default function Index() {
  const [showSplash, setShowSplash] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);

      router.replace('/home');
    }, 2000);
    return () => clearTimeout(timer);
  }, [router]);

  if (showSplash) {
    return (
      <View style={styles.splash}>
      </View>
    );
  }


  return null;
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  splashText: {
    fontSize: 32,
    color: '#fff',
  },
});
